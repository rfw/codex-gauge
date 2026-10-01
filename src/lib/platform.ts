export function isMacOS(): boolean {
  if (typeof navigator === "undefined") {
    return false
  }

  return /Macintosh|Mac OS X/i.test(navigator.userAgent)
}
