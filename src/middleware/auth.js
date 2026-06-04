const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// Hard guard: refuse to start in production with a placeholder secret.
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET
      || process.env.JWT_SECRET === 'change-me-in-production'
      || process.env.JWT_SECRET === 'your-super-secret-jwt-key-min-32-chars'
      || process.env.JWT_SECRET.length < 32) {
    // eslint-disable-next-line no-console
    console.error('FATAL: JWT_SECRET must be set to a strong (>=32 char) value in production.');
    process.exit(1);
  }
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });

  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    const code = e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    return res.status(401).json({ error: 'Invalid or expired token', code });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required', code: 'NO_USER' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

module.exports = { signToken, verifyToken, authenticate, requireRole };
