// SSE (text/event-stream) helpers: incremental parsing, frame formatting,
// and first-data-frame validation. Zero dependencies, plain ESM.

// Block separators recognized in the wild: \n\n, \r\n\r\n, \r\r.
const SEP = /\r\n\r\n|\n\n|\r\r/;
// Line terminators inside a block.
const LINE = /\r\n|\r|\n/;

// Parse one block (no separators inside) into an event, or null.
// A block only yields an event when at least one data: field is present
// (SSE spec). data: lines are concatenated with '\n' per spec; a single
// leading space after the colon is stripped.
function parseBlock(block) {
  let event = 'message';
  const dataLines = [];
  let id;
  let retry;
  for (const line of block.split(LINE)) {
    if (line === '' || line.startsWith(':')) continue; // blank or comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\u0000')) id = value;
    else if (field === 'retry' && /^[0-9]+$/.test(value)) retry = Number(value);
  }
  if (dataLines.length === 0) return null;
  const out = { event, data: dataLines.join('\n') };
  if (id !== undefined) out.id = id;
  if (retry !== undefined) out.retry = retry;
  return out;
}

// Incremental SSE stream parser. Feed string fragments with push();
// completed events are returned per call. flush() dispatches a trailing
// block that never received a final separator (stream ended mid-event).
export function createSSEStreamParser() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const events = [];
      for (;;) {
        const m = SEP.exec(buffer);
        if (m === null) break;
        const block = buffer.slice(0, m.index);
        if (block !== '') {
          const ev = parseBlock(block);
          if (ev) events.push(ev);
        }
        buffer = buffer.slice(m.index + m[0].length);
      }
      return events;
    },
    flush() {
      const rest = buffer;
      buffer = '';
      if (rest === '') return [];
      const ev = parseBlock(rest);
      return ev ? [ev] : [];
    },
  };
}

// Format one event as a wire frame. LF-normalized: the output always
// ends with a blank line (\n\n) regardless of upstream line endings.
export function formatSSEFrame({ event = 'message', data = '', id, retry } = {}) {
  let frame = '';
  if (event !== 'message') frame += `event: ${event}\n`;
  for (const line of String(data).split('\n')) frame += `data: ${line}\n`;
  if (id != null) frame += `id: ${id}\n`;
  if (retry != null) frame += `retry: ${retry}\n`;
  return frame + '\n';
}

// Inspect the start of an SSE buffer for the first complete data frame.
// 'need_more': no complete block yet. 'invalid': complete block without a
// data: field, or data is not valid JSON (upstream error before first
// data — caller fails over). 'ok': first frame is valid; consumedBytes is
// the offset just past it.
export function tryParseFirstDataFrame(buffer) {
  const m = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  if (m === null) return { status: 'need_more' };
  const block = buffer.slice(0, m.index);
  const consumedBytes = m.index + m[0].length;
  const dataLines = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  if (dataLines.length === 0) return { status: 'invalid' };
  const data = dataLines.join('\n');
