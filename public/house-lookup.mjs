export function createHouseLookup(request) {
  const pending = new Map();
  return function housesForStreet(street) {
    const key = street.trim();
    if (!key) return Promise.resolve([]);
    if (!pending.has(key)) {
      pending.set(key, Promise.resolve().then(() => request(key)).then(data => {
        if (!Array.isArray(data.houses) || data.houses.some(house => typeof house !== 'string' || !house)) {
          throw new Error('The building list could not be read. Focus the field to retry.');
        }
        return data.houses;
      }).catch(error => { pending.delete(key); throw error; }));
    }
    return pending.get(key);
  };
}
