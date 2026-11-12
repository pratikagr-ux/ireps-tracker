// Ported from ireps_codes.py — static lookup tables for decoding IREPS
// railway/production-unit codes and common depot abbreviations into
// human-readable names and locations. Keep in sync with the Python version.
export const RAILWAY_LOCATIONS = {
  'BLW': ['Banaras Locomotive Works', 'Varanasi, Uttar Pradesh'],
  'CENTRAL RLY': ['Central Railway', 'Mumbai (CSMT), Maharashtra'],
  'CLW': ['Chittaranjan Locomotive Works', 'Chittaranjan, West Bengal'],
  'CORE': ['Central Organisation for Railway Electrification', 'Prayagraj, Uttar Pradesh'],
  'CRIS': ['Centre for Railway Information Systems', 'New Delhi'],
  'DFC CORPORATE OFFICE': ['Dedicated Freight Corridor Corporation of India Ltd.', 'New Delhi'],
  'DMRC': ['Delhi Metro Rail Corporation', 'New Delhi'],
  'EAST CENTRAL RLY': ['East Central Railway', 'Hajipur, Bihar'],
  'EASTERN RLY': ['Eastern Railway', 'Kolkata, West Bengal'],
  'ECOR': ['East Coast Railway', 'Bhubaneswar, Odisha'],
  'ICF': ['Integral Coach Factory', 'Chennai (Perambur), Tamil Nadu'],
  'IREPS': ['Indian Railways E-Procurement System', 'New Delhi'],
  'IREPS TESTING2': ['IREPS internal test unit', 'sandbox entry, no real location'],
  'IREPS-TESTING': ['IREPS internal test unit', 'sandbox entry, no real location'],
  'KRCL': ['Konkan Railway Corporation Ltd.', 'CBD Belapur, Navi Mumbai, Maharashtra'],
  'MCF/ RBL': ['Modern Coach Factory', 'Raebareli, Uttar Pradesh'],
  'METRO RAILWAY': ['Metro Railway Kolkata', 'Kolkata, West Bengal'],
  'N F RLY': ['Northeast Frontier Railway', 'Maligaon, Guwahati, Assam'],
  'N F RLY CONSTRUCTION': ['Northeast Frontier Railway Construction Organisation', 'Guwahati, Assam'],
  'NORTH CENTRAL RLY': ['North Central Railway', 'Prayagraj, Uttar Pradesh'],
  'NORTH EASTERN RLY': ['North Eastern Railway', 'Gorakhpur, Uttar Pradesh'],
  'NORTH WESTERN RLY': ['North Western Railway', 'Jaipur, Rajasthan'],
  'NORTHERN RLY': ['Northern Railway', 'New Delhi'],
  'PLW': ['Patiala Locomotive Works', 'Patiala, Punjab'],
  'RCF': ['Rail Coach Factory', 'Kapurthala, Punjab'],
  'RWF': ['Rail Wheel Factory', 'Yelahanka, Bengaluru, Karnataka'],
  'RWP/BELA': ['Rail Wheel Plant', 'Bela, Chhapra, Bihar'],
  'SOUTH CENTRAL RLY': ['South Central Railway', 'Secunderabad, Telangana'],
  'SOUTH COAST RAILWAY': ['South Coast Railway', 'Visakhapatnam, Andhra Pradesh'],
  'SOUTH EAST CENTRAL RLY': ['South East Central Railway', 'Bilaspur, Chhattisgarh'],
  'SOUTH EASTERN RLY': ['South Eastern Railway', 'Garden Reach, Kolkata, West Bengal'],
  'SOUTH WESTERN RLY': ['South Western Railway', 'Hubballi, Karnataka'],
  'SOUTHERN RLY': ['Southern Railway', 'Chennai, Tamil Nadu'],
  'WEST CENTRAL RLY': ['West Central Railway', 'Jabalpur, Madhya Pradesh'],
  'WESTERN RLY': ['Western Railway', 'Mumbai (Churchgate), Maharashtra'],
};

export const DEPOT_ABBREVIATIONS = { 'GSD': 'General Stores Depot' };

export function describeRailway(railway) {
  const entry = RAILWAY_LOCATIONS[(railway || '').trim()];
  if (!entry) return railway;
  const [fullName, location] = entry;
  return `${fullName} - ${location}`;
}

export function describeDepot(railway, depot) {
  const tokens = (depot || '').split(' ').filter(Boolean);
  const expanded = tokens.map(t => DEPOT_ABBREVIATIONS[t] || t);
  let out = expanded.join(' ');
  if ((railway || '').trim() === 'BLW' && tokens.includes('DLW')) {
    out += ' (DLW = formerly Diesel Locomotive Works, now Banaras Locomotive Works)';
  }
  return out;
}

export function describeLocation(railway, depot) {
  return `${describeRailway(railway)} / ${describeDepot(railway, depot)}`;
}
