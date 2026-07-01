const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_123';

module.exports = function (req, res, next) {
  // 1. Get the token from the header
  const token = req.header('Authorization');

  // 2. Check if no token exists
  if (!token) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    // 3. Verify the token (Remove 'Bearer ' from the string if it exists)
    const decoded = jwt.verify(token.replace('Bearer ', ''), JWT_SECRET);
    
    // 4. Attach the user ID to the request so the next route can use it
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};