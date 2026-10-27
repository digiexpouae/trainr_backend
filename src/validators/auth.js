const { z } = require('zod');

const idToken = z.string().min(1, 'idToken is required');

// Phone number comes from the verified Firebase token, never from the request body.
const registerUserSchema = z.object({
  idToken,
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  email: z.email().max(100).optional(),
  acceptedTerms: z.literal(true, { error: 'Terms must be accepted' }),
});

const loginSchema = z.object({ idToken });

module.exports = { registerUserSchema, loginSchema };
