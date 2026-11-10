// Every success response in the API goes through these helpers,
// so the shape is always: { success: true, message, data }

const sendSuccess = (res, { message = 'Success', data = null, statusCode = 200 } = {}) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
};

// 201 for anything that creates a new record
const sendCreated = (res, { message = 'Created successfully', data = null } = {}) => {
  return sendSuccess(res, { message, data, statusCode: 201 });
};

// Lists: data stays an array, meta is optional (page, limit, total)
const sendList = (res, { message = 'Fetched successfully', data = [], meta } = {}) => {
  return res.status(200).json({
    success: true,
    message,
    data,
    ...(meta && { meta }),
  });
};

module.exports = { sendSuccess, sendCreated, sendList };
