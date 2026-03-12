const TARGETS = [
  { facilityId: 462, parkName: 'Doheny SB', facilityName: 'North Loop', tier: 1 },
  { facilityId: 464, parkName: 'Doheny SB', facilityName: 'South Loop', tier: 1 },
  { facilityId: 674, parkName: 'San Onofre SB', facilityName: 'Bluff 1-23', tier: 1 },
  { facilityId: 675, parkName: 'San Onofre SB', facilityName: 'Bluff 120-145', tier: 1 },
  { facilityId: 678, parkName: 'San Onofre SB', facilityName: 'Bluff 24-45', tier: 1 },
  { facilityId: 680, parkName: 'San Onofre SB', facilityName: 'Bluff 46-66', tier: 1 },
  { facilityId: 681, parkName: 'San Onofre SB', facilityName: 'Bluff 67-93', tier: 1 },
  { facilityId: 682, parkName: 'San Onofre SB', facilityName: 'Bluff 94-119', tier: 1 },
  { facilityId: 676, parkName: 'San Onofre SB', facilityName: 'Bluff 146-156', tier: 1 },
  { facilityId: 677, parkName: 'San Onofre SB', facilityName: 'Bluff 157-175', tier: 1 },
  { facilityId: 665, parkName: 'San Elijo SB', facilityName: 'Middle Section', tier: 2 },
  { facilityId: 666, parkName: 'San Elijo SB', facilityName: 'Northern Section', tier: 2 },
  { facilityId: 670, parkName: 'San Elijo SB', facilityName: 'Southern Section', tier: 2 },
  { facilityId: 539, parkName: 'Leo Carrillo SP', facilityName: 'Canyon 1-24, 78-133', tier: 3 },
  { facilityId: 542, parkName: 'Leo Carrillo SP', facilityName: 'Canyon 25-77', tier: 3 },
];

// Dynamically generate all upcoming Fri–Sun (2-night) weekends from now through ~6 months out.
// Called on each monitor run so the list stays current.
function getDateRanges(): Array<{ label: string; startDate: string; nights: number }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayOfWeek = today.getDay(); // 0=Sun … 5=Fri … 6=Sat
  const daysToFriday = (5 - dayOfWeek + 7) % 7; // 0 if today is Friday
  const firstFriday = new Date(today.getTime() + daysToFriday * 86400000);

  const sixMonthsOut = new Date(today);
  sixMonthsOut.setMonth(sixMonthsOut.getMonth() + 6);

  const ranges: Array<{ label: string; startDate: string; nights: number }> = [];
  let current = new Date(firstFriday);
  while (current <= sixMonthsOut) {
    const mm = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const yyyy = current.getFullYear();
    const startDate = `${mm}-${dd}-${yyyy}`;
    const sunday = new Date(current.getTime() + 2 * 86400000);
    const label =
      `Fri, ${current.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` +
      ` – Sun, ${sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    ranges.push({ label, startDate, nights: 2 });
    current = new Date(current.getTime() + 7 * 86400000);
  }
  return ranges;
}

// Static park metadata: parkId is the ReserveCalifornia parent park ID used for booking URLs.
const PARK_INFO: Record<string, { parkId: number; description: string }> = {
  'Doheny SB': {
    parkId: 461,
    description: 'Protected cove in Dana Point with direct beach access. Great for families and surfers.',
  },
  'San Onofre SB': {
    parkId: 672,
    description: 'Classic SoCal blufftop camping. Long sandy beach, easy surf access, very chill vibe.',
  },
  'San Elijo SB': {
    parkId: 663,
    description: 'Oceanfront blufftop camping in Cardiff-by-the-Sea. Walkable to restaurants, reliable surf, year-round favorite.',
  },
  'Leo Carrillo SP': {
    parkId: 537,
    description: 'Wild beach camping north of Malibu with sea caves and tide pools. Campfires allowed on the beach.',
  },
};

module.exports = {
  getDateRanges,
  PARK_INFO,
  TARGETS,
};
