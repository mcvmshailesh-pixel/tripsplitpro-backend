const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

module.exports = async function (req, res, next) {
  // Extract tripId from params, body, or query
  const tripId = req.params.tripId || req.body.tripId || req.query.tripId || req.params.id;
  
  if (!tripId) {
    return res.status(400).json({ message: 'Trip ID is required' });
  }

  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: 'No authorization token, access denied' });
  }

  try {
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        members: {
          where: { userId: req.user.id }
        }
      }
    });

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    const isCreator = trip.creatorId === req.user.id;
    const isMember = trip.members.length > 0;
    const isAdmin = req.user.role === 'ADMIN';

    if (!isCreator && !isMember && !isAdmin) {
      return res.status(403).json({ message: 'Access denied. You do not have permission to access this trip.' });
    }

    req.trip = trip; // Cache the trip object on the request
    next();
  } catch (error) {
    console.error('Error in tripAuthMiddleware:', error);
    res.status(500).json({ message: 'Server error during trip authorization check' });
  }
};
