const AppError = require('./AppError');

// Parses `data` with a zod schema; throws a 400 AppError listing the problems.
function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    throw new AppError(400, details[0].message, details);
  }
  return result.data;
}

module.exports = validate;
