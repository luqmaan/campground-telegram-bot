const TARGETS = [
  { facilityId: 462, parkName: 'Doheny SB', facilityName: 'North Loop', tier: 1 },
  { facilityId: 464, parkName: 'Doheny SB', facilityName: 'South Loop', tier: 1 },
  { facilityId: 662, parkName: 'San Clemente SB', facilityName: 'Tent East', tier: 1 },
  { facilityId: 664, parkName: 'San Clemente SB', facilityName: 'Tent West', tier: 1 },
  { facilityId: 674, parkName: 'San Onofre SB', facilityName: 'Bluff 1-23', tier: 1 },
  { facilityId: 675, parkName: 'San Onofre SB', facilityName: 'Bluff 120-145', tier: 1 },
  { facilityId: 678, parkName: 'San Onofre SB', facilityName: 'Bluff 24-45', tier: 1 },
  { facilityId: 680, parkName: 'San Onofre SB', facilityName: 'Bluff 46-66', tier: 1 },
  { facilityId: 681, parkName: 'San Onofre SB', facilityName: 'Bluff 67-93', tier: 1 },
  { facilityId: 682, parkName: 'San Onofre SB', facilityName: 'Bluff 94-119', tier: 1 },
  { facilityId: 676, parkName: 'San Onofre SB', facilityName: 'Bluff 146-156', tier: 1 },
  { facilityId: 677, parkName: 'San Onofre SB', facilityName: 'Bluff 157-175', tier: 1 },
  { facilityId: 357, parkName: 'Carpinteria SB', facilityName: 'Anacapa', tier: 1 },
  { facilityId: 358, parkName: 'Carpinteria SB', facilityName: 'Santa Cruz', tier: 1 },
  { facilityId: 359, parkName: 'Carpinteria SB', facilityName: 'San Miguel', tier: 1 },
  { facilityId: 360, parkName: 'Carpinteria SB', facilityName: 'Santa Rosa', tier: 1 },
  { facilityId: 447, parkName: 'Crystal Cove SP', facilityName: 'Moro Campground', tier: 2 },
  { facilityId: 2158, parkName: 'Crystal Cove SP', facilityName: 'Upper Moro', tier: 2 },
  { facilityId: 2159, parkName: 'Crystal Cove SP', facilityName: 'Lower Moro', tier: 2 },
  { facilityId: 2157, parkName: 'Crystal Cove SP', facilityName: 'Deer Canyon', tier: 2 },
  { facilityId: 665, parkName: 'San Elijo SB', facilityName: 'Middle Section', tier: 2 },
  { facilityId: 666, parkName: 'San Elijo SB', facilityName: 'Northern Section', tier: 2 },
  { facilityId: 670, parkName: 'San Elijo SB', facilityName: 'Southern Section', tier: 2 },
  { facilityId: 708, parkName: 'South Carlsbad SB', facilityName: 'Northern 1-34', tier: 2 },
  { facilityId: 715, parkName: 'South Carlsbad SB', facilityName: 'Northern 35-102', tier: 2 },
  { facilityId: 712, parkName: 'South Carlsbad SB', facilityName: 'Southern 153-187', tier: 2 },
  { facilityId: 714, parkName: 'South Carlsbad SB', facilityName: 'Southern 131-152', tier: 2 },
  { facilityId: 685, parkName: 'San Onofre SB', facilityName: 'San Mateo 1-67', tier: 2 },
  { facilityId: 686, parkName: 'San Onofre SB', facilityName: 'San Mateo 68-100', tier: 2 },
  { facilityId: 683, parkName: 'San Onofre SB', facilityName: 'San Mateo 101-140', tier: 2 },
  { facilityId: 684, parkName: 'San Onofre SB', facilityName: 'San Mateo 141-157', tier: 2 },
  { facilityId: 633, parkName: 'Refugio SB', facilityName: 'Refugio Campground', tier: 2 },
  { facilityId: 376, parkName: 'El Capitan SB', facilityName: 'Lower Section', tier: 2 },
  { facilityId: 377, parkName: 'El Capitan SB', facilityName: 'Middle Section', tier: 2 },
  { facilityId: 379, parkName: 'El Capitan SB', facilityName: 'Upper Section', tier: 2 },
  { facilityId: 562, parkName: 'Malibu Creek SP', facilityName: 'Creek Campground', tier: 2 },
  { facilityId: 491, parkName: 'Gaviota SP', facilityName: 'Gaviota Campground', tier: 2 },
  { facilityId: 539, parkName: 'Leo Carrillo SP', facilityName: 'Canyon 1-24, 78-133', tier: 3 },
  { facilityId: 542, parkName: 'Leo Carrillo SP', facilityName: 'Canyon 25-77', tier: 3 },
  { facilityId: 2031, parkName: 'Point Mugu SP', facilityName: 'Thornhill Broome', tier: 3 },
  { facilityId: 624, parkName: 'Point Mugu SP', facilityName: 'Sycamore Canyon', tier: 3 },
  { facilityId: 417, parkName: 'Bolsa Chica SB', facilityName: 'Campground 1-31 (RV)', tier: 3 },
  { facilityId: 418, parkName: 'Bolsa Chica SB', facilityName: 'Campground 32-57 (RV)', tier: 3 },
];

const DATE_RANGES = [
  { label: 'Fri-Mon (3 nights)', startDate: '04-03-2026', nights: 3 },
];

// Static park metadata: parkId is the ReserveCalifornia parent park ID used for booking URLs.
// Booking link format: https://www.reservecalifornia.com/#!park/{parkId}/{facilityId}
const PARK_INFO: Record<string, { parkId: number; description: string }> = {
  'Doheny SB': {
    parkId: 461,
    description: 'Protected cove in Dana Point with direct beach access. Great for families and surfers.',
  },
  'San Clemente SB': {
    parkId: 660,
    description: 'Blufftop camping above a classic surf break. Train access, walkable to downtown San Clemente.',
  },
  'San Onofre SB': {
    parkId: 672,
    description: 'Classic SoCal blufftop and San Mateo canyon camping. Long sandy beach, easy surf access, very chill vibe.',
  },
  'Carpinteria SB': {
    parkId: 356,
    description: 'Calm family-friendly beach near Santa Barbara. Warm gentle surf, called "world\'s safest beach."',
  },
  'Crystal Cove SP': {
    parkId: 445,
    description: 'Canyon and coastal camping in Newport Beach / Laguna. Steps from pristine tide pools and Crystal Cove beaches.',
  },
  'San Elijo SB': {
    parkId: 663,
    description: 'Oceanfront blufftop camping in Cardiff-by-the-Sea. Walkable to restaurants, reliable surf, year-round favorite.',
  },
  'South Carlsbad SB': {
    parkId: 706,
    description: 'Blufftop camping with sweeping Pacific views in Carlsbad. Easy beach access and great sunsets.',
  },
  'Refugio SB': {
    parkId: 631,
    description: 'Sheltered palm-lined cove west of Santa Barbara. Excellent snorkeling, kayaking, and calm swimming.',
  },
  'El Capitan SB': {
    parkId: 374,
    description: 'Shaded canyon camping above the coast near Santa Barbara. Natural tidepools and kelp forest access.',
  },
  'Malibu Creek SP': {
    parkId: 561,
    description: 'Inland canyon camping in the Santa Monica Mountains. MASH filming location; creek swimming and great hiking.',
  },
  'Gaviota SP': {
    parkId: 489,
    description: 'Uncrowded beach camping west of Santa Barbara near hot springs. Remote and peaceful.',
  },
  'Leo Carrillo SP': {
    parkId: 537,
    description: 'Wild beach camping north of Malibu with sea caves and tide pools. Campfires allowed on the beach.',
  },
  'Point Mugu SP': {
    parkId: 617,
    description: 'Remote beachfront and canyon camping on the PCH north of Malibu. Very secluded, minimal crowds.',
  },
  'Bolsa Chica SB': {
    parkId: 415,
    description: 'RV-friendly beach camping in Huntington Beach next to the Bolsa Chica Ecological Reserve.',
  },
};

module.exports = {
  DATE_RANGES,
  PARK_INFO,
  TARGETS,
};
