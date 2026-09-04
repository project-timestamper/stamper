export const hashListContains = (
  list: Buffer,
  digest: Buffer,
  hashBytes: number
): boolean => {
  if (digest.length !== hashBytes) {
    throw new Error(`expected ${hashBytes}-byte digest`);
  }
  if (list.length % hashBytes !== 0) {
    throw new Error(
      `hash list length ${list.length} is not a multiple of ${hashBytes}`
    );
  }
  for (let offset = 0; offset < list.length; offset += hashBytes) {
    if (list.subarray(offset, offset + hashBytes).equals(digest)) {
      return true;
    }
  }
  return false;
};
