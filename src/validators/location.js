const { z } = require('zod');

const managementSchema = z.object({
  companyName: z.string().trim().max(100).optional(),
  contactName: z.string().trim().min(1).max(100),
  contactPhone: z.string().trim().max(20).optional(),
  contactEmail: z.string().trim().email().max(100).optional(),
});

// "Other" in the building list: the resident types a building we don't have yet.
const newBuildingSchema = z.object({
  name: z.string().trim().min(1).max(50),
  management: managementSchema.optional(),
});

// An apartment address (type 'building') uses either an existing approved building
// (buildingId) or a new one (newBuilding). Any other type has no building.
const locationSchema = z
  .object({
    type: z.enum(['home', 'work', 'building', 'other']).default('other'),
    label: z.string().trim().max(50).optional(),
    address: z.string().trim().min(1).max(200),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    buildingId: z.coerce.number().int().positive().optional(),
    newBuilding: newBuildingSchema.optional(),
  })
  .refine(
    (l) =>
      l.type === 'building'
        ? (l.buildingId == null) !== (l.newBuilding == null)
        : l.buildingId == null && l.newBuilding == null,
    {
      message: "Apartments need either buildingId or newBuilding; other types need neither",
      path: ['buildingId'],
    }
  );


  const locationIdSchema = z.object({ id: z.coerce.number().int().positive() });

const updateLocationSchema = z
  .object({
    label: z.string().trim().max(50).optional(),
    address: z.string().trim().min(1).max(200).optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    // Not editable: type and building may be sent back as saved, but a different value is
    // rejected by the controller. To move to another type or building, save a new address.
    type: z.enum(['home', 'work', 'building', 'other']).optional(),
    buildingId: z.coerce.number().int().positive().nullish(),
    newBuilding: z.never({ error: 'building cannot be changed' }).optional(),
  })
  .refine((u) => Object.keys(u).length > 0, { message: 'Nothing to update' })
  .refine((u) => (u.latitude == null) === (u.longitude == null), {
    message: 'latitude and longitude must be sent together',
    path: ['latitude'],
  });


module.exports = { locationSchema,locationIdSchema,updateLocationSchema };
