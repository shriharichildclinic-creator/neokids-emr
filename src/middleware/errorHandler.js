const logger = require('../utils/logger');

const notFound = (req, res, next) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
};

const errorHandler = (err, req, res, next) => {
  logger.error('Unhandled error:', err);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { notFound, errorHandler, asyncHandler };
