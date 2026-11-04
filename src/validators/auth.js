const { z } = require('zod');

// Phone number comes from the verified Firebase token, never from the request body.
const registerUserSchema = z.object({
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  email: z.email().max(100).optional(),
  acceptedTerms: z.literal(true, { error: 'Terms must be accepted' }),
});

module.exports = { registerUserSchema };
