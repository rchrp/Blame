/** Parse concatenated JPEGs without retaining an unbounded broken stream. */
export async function* mjpegFrames(stream: AsyncIterable<Buffer>) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 16 * 1024 * 1024) throw new Error("The device frame stream is too large.");
    while (true) {
      const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { buffer = buffer.subarray(-1); break; }
      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { buffer = buffer.subarray(start); break; }
      yield buffer.subarray(start, end + 2);
      buffer = buffer.subarray(end + 2);
    }
  }
}
