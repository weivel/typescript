/** The file name CMake gives the shared library `name` on `platform`. */
export function sharedLibraryFileName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `${name}.dll`;
  }
  if (platform === "darwin") {
    return `lib${name}.dylib`;
  }
  return `lib${name}.so`;
}
