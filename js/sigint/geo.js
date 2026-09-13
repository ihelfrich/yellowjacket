// Distance between two points on the earth, in kilometres.
// Split out of the receiver list so the pure logic can be tested without a
// network and imported by the browser without a node module.
export function greatCircleKm(a, b) {
  if (!a || !b || a.length < 2 || b.length < 2) return NaN;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const la1 = a[0] * rad, la2 = b[0] * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
