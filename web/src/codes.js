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

// Standard 3-letter Indian Railways / MSTC division-city codes, as used in
// IREPS's own "Custodian" field (e.g. "DMS-MISC-AMV-LKO") and in MSTC's
// own regional-office list. Shared across both since they're the same
// real-world city/division abbreviations, not source-specific.
export const CITY_CODES = {
  'BBR': 'Bhubaneswar', 'BLR': 'Bangalore', 'BPL': 'Bhopal', 'CDG': 'Chandigarh',
  'ERO': 'Kolkata', 'GHY': 'Guwahati', 'HYD': 'Hyderabad', 'JPR': 'Jaipur',
  'LKO': 'Lucknow', 'NRO': 'Delhi', 'PTN': 'Patna', 'RNC': 'Ranchi',
  'RPR': 'Raipur', 'SRO': 'Chennai', 'TVC': 'Trivandrum', 'VAD': 'Vadodara',
  'VZG': 'Visakhapatnam', 'WRO': 'Mumbai',
};

// Common Indian Railways department/role abbreviations as seen in the
// "Custodian" field of a lot's catalogue detail (e.g. "SSE PWAY MNI",
// "DMS-MISC-AMV-LKO"). Best-effort -- an unrecognized token is left as-is
// rather than guessed at.
export const CUSTODIAN_ABBREVIATIONS = {
  'SSE': 'Senior Section Engineer', 'SE': 'Section Engineer',
  'ADEN': 'Assistant Divisional Engineer', 'DEN': 'Divisional Engineer',
  'SR': 'Senior', 'SRDEN': 'Senior Divisional Engineer',
  'DME': 'Divisional Mechanical Engineer', 'DEE': 'Divisional Electrical Engineer',
  'DSTE': 'Divisional Signal & Telecom Engineer', 'DRM': 'Divisional Railway Manager',
  'PWAY': 'Permanent Way', 'PW': 'Permanent Way', 'PWI': 'Permanent Way Inspector',
  'DMS': 'Divisional Materials Section', 'CMM': 'Chief Materials Manager',
  'COS': 'Controller of Stores', 'SSO': 'Senior Section Officer',
  'MISC': 'Miscellaneous', 'STORES': 'Stores', 'DEPOT': 'Depot',
  'SD': 'Stores Depot', 'GSD': 'General Stores Depot', 'WHS': 'Warehouse',
  'ELEC': 'Electrical', 'MECH': 'Mechanical', 'SIG': 'Signal', 'TELE': 'Telecom',
  'ENGG': 'Engineering', 'OPTG': 'Operating', 'COMML': 'Commercial',
};

// Best-effort decipher of an IREPS lot's "Custodian" field (e.g.
// "DMS-MISC-AMV-LKO" or "SSE PWAY MNI") into its expanded department/
// division names, splitting on whichever of space/dash/slash it uses.
// Unrecognized tokens (e.g. a specific depot code we don't have, like
// "AMV" above) are left as-is -- this is a readability aid, not a
// guaranteed-correct translation.
export function decipherCustodian(custodian) {
  const raw = (custodian || '').trim();
  if (!raw) return '';
  const tokens = raw.split(/[\s\-/]+/).filter(Boolean);
  const expanded = tokens.map(t => {
    const key = t.toUpperCase();
    return CUSTODIAN_ABBREVIATIONS[key] || CITY_CODES[key] || t;
  });
  const decipheredChanged = expanded.some((e, i) => e !== tokens[i]);
  if (!decipheredChanged) return raw;
  return `${raw} (${expanded.join(' - ')})`;
}

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
