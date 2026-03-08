export class LineSplitter {
  private buffer = "";
  private handler: ((line: string) => void) | null = null;

  onLine(handler: (line: string) => void): void {
    this.handler = handler;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) this.handler?.(trimmed);
    }
  }
}
