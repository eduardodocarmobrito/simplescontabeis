// archiver@7 é CJS (module.exports = função), mas @types/archiver só cobre a API ESM da v8 —
// shim mínimo só com o que usamos (criar um zip, adicionar entradas, finalizar).
declare module "archiver" {
  import { Writable } from "stream";

  interface ArchiverInstance extends Writable {
    pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
    append(source: Buffer | NodeJS.ReadableStream | string, data: { name: string }): ArchiverInstance;
    finalize(): Promise<void>;
    on(event: "error", listener: (err: Error) => void): ArchiverInstance;
    on(event: string, listener: (...args: any[]) => void): ArchiverInstance;
  }

  function archiver(format: "zip" | "tar", options?: { zlib?: { level?: number } }): ArchiverInstance;
  export = archiver;
}
