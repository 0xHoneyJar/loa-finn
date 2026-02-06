// Type declaration for fs-ext (optional flock dependency)
// The upstream WAL manager uses dynamic import with fallback — this declaration
// satisfies TypeScript without requiring the actual native module.

declare module "fs-ext" {
  export function flock(
    fd: number,
    operation: number,
    callback: (err: Error | null) => void,
  ): void
}
