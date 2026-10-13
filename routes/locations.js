const express = require('express');
const https = require('https');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/authMiddleware');
const tripAuthMiddleware = require('../middleware/tripAuthMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

// ==========================================
// 1. TRIP DESTINATIONS & WAYPOINTS
// ==========================================

// GET: Fetch all destinations / waypoints for a trip
router.get('/trip/:tripId/destinations', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  try {
    const destinations = await prisma.tripDestination.findMany({
      where: { tripId },
      orderBy: [
        { order: 'asc' },
        { plannedDate: 'asc' },
        { createdAt: 'asc' }
      ]
    });
    res.json(destinations);
  } catch (error) {
    console.error('Error fetching destinations:', error);
    res.status(500).json({ message: 'Server error while fetching trip destinations.' });
  }
});

// POST: Add a new destination / itinerary point
router.post('/trip/:tripId/destinations', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  const { name, category, latitude, longitude, address, notes, plannedDate, order } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ message: 'Destination name is required.' });
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ message: 'Valid latitude (-90 to 90) and longitude (-180 to 180) are required.' });
  }

  try {
    const newDestination = await prisma.tripDestination.create({
      data: {
        tripId,
        name: name.trim(),
        category: category || 'Attraction',
        latitude: lat,
        longitude: lng,
        address: address ? address.trim() : null,
        notes: notes ? notes.trim() : null,
        plannedDate: plannedDate ? new Date(plannedDate) : null,
        order: order !== undefined ? parseInt(order, 10) : 0,
        createdBy: req.user.id
      }
    });

    // Notify other trip members
    const trip = req.trip;
    const members = await prisma.tripMember.findMany({
      where: { tripId, NOT: { userId: req.user.id } }
    });

    const notifPromises = members.map(m =>
      prisma.notification.create({
        data: {
          userId: m.userId,
          title: 'New Trip Destination Added 📍',
          message: `${req.user.name} added "${newDestination.name}" to trip "${trip.name}".`,
          type: 'INFO'
        }
      }).catch(err => console.error('Notification error:', err))
    );

    if (trip.creatorId !== req.user.id) {
      notifPromises.push(
        prisma.notification.create({
          data: {
            userId: trip.creatorId,
            title: 'New Trip Destination Added 📍',
            message: `${req.user.name} added "${newDestination.name}" to trip "${trip.name}".`,
            type: 'INFO'
          }
        }).catch(err => console.error('Notification error:', err))
      );
    }

    await Promise.all(notifPromises);

    res.status(201).json({ message: 'Destination added successfully.', destination: newDestination });
  } catch (error) {
    console.error('Error adding destination:', error);
    res.status(500).json({ message: 'Server error while adding destination.' });
  }
});

// PUT: Update a destination (e.g. mark visited, update notes or dates)
router.put('/trip/:tripId/destinations/:id', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId, id } = req.params;
  const { name, category, latitude, longitude, address, notes, plannedDate, visited, order } = req.body;

  try {
    const existing = await prisma.tripDestination.findFirst({
      where: { id, tripId }
    });

    if (!existing) {
      return res.status(404).json({ message: 'Destination not found in this trip.' });
    }

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (category !== undefined) data.category = category;
    if (latitude !== undefined) data.latitude = parseFloat(latitude);
    if (longitude !== undefined) data.longitude = parseFloat(longitude);
    if (address !== undefined) data.address = address ? address.trim() : null;
    if (notes !== undefined) data.notes = notes ? notes.trim() : null;
    if (plannedDate !== undefined) data.plannedDate = plannedDate ? new Date(plannedDate) : null;
    if (visited !== undefined) data.visited = Boolean(visited);
    if (order !== undefined) data.order = parseInt(order, 10);

    const updated = await prisma.tripDestination.update({
      where: { id },
      data
    });

    res.json({ message: 'Destination updated successfully.', destination: updated });
  } catch (error) {
    console.error('Error updating destination:', error);
    res.status(500).json({ message: 'Server error while updating destination.' });
  }
});

// DELETE: Delete a destination
router.delete('/trip/:tripId/destinations/:id', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId, id } = req.params;
  try {
    const existing = await prisma.tripDestination.findFirst({
      where: { id, tripId }
    });

    if (!existing) {
      return res.status(404).json({ message: 'Destination not found in this trip.' });
    }

    await prisma.tripDestination.delete({ where: { id } });
    res.json({ message: 'Destination removed successfully.' });
  } catch (error) {
    console.error('Error deleting destination:', error);
    res.status(500).json({ message: 'Server error while deleting destination.' });
  }
});

// ==========================================
// 2. LIVE MEMBER LOCATION SHARING
// ==========================================

// POST: Share / update current location in a trip
router.post('/trip/:tripId/share', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  const { latitude, longitude, accuracy, statusMessage, isSharing, batteryLevel } = req.body;

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ message: 'Valid coordinates are required.' });
  }

  try {
    const location = await prisma.memberLocation.upsert({
      where: {
        tripId_userId: {
          tripId,
          userId: req.user.id
        }
      },
      update: {
        latitude: lat,
        longitude: lng,
        accuracy: accuracy !== undefined && accuracy !== null ? parseFloat(accuracy) : null,
        statusMessage: statusMessage !== undefined ? statusMessage : 'Sharing active location',
        isSharing: isSharing !== undefined ? Boolean(isSharing) : true,
        batteryLevel: batteryLevel !== undefined && batteryLevel !== null ? parseFloat(batteryLevel) : null,
        updatedAt: new Date()
      },
      create: {
        tripId,
        userId: req.user.id,
        latitude: lat,
        longitude: lng,
        accuracy: accuracy !== undefined && accuracy !== null ? parseFloat(accuracy) : null,
        statusMessage: statusMessage || 'Sharing active location',
        isSharing: isSharing !== undefined ? Boolean(isSharing) : true,
        batteryLevel: batteryLevel !== undefined && batteryLevel !== null ? parseFloat(batteryLevel) : null
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            mobile: true
          }
        }
      }
    });

    res.json({ message: 'Location updated successfully.', location });
  } catch (error) {
    console.error('Error sharing member location:', error);
    res.status(500).json({ message: 'Server error while updating member location.' });
  }
});

// GET: Fetch all active shared locations of trip members
router.get('/trip/:tripId/members', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  try {
    const locations = await prisma.memberLocation.findMany({
      where: {
        tripId
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            mobile: true
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Annotate freshness
    const now = Date.now();
    const formatted = locations.map(loc => {
      const diffMs = now - new Date(loc.updatedAt).getTime();
      const diffMinutes = Math.floor(diffMs / 60000);
      let freshness = 'Just now';
      if (diffMinutes >= 60) {
        const diffHours = Math.floor(diffMinutes / 60);
        freshness = `${diffHours}h ago`;
      } else if (diffMinutes > 0) {
        freshness = `${diffMinutes}m ago`;
      }

      return {
        ...loc,
        diffMinutes,
        freshness,
        isOnline: diffMinutes < 15 && loc.isSharing // Considered live if updated in last 15 min
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching member locations:', error);
    res.status(500).json({ message: 'Server error while fetching member locations.' });
  }
});

// PUT: Toggle location sharing ON/OFF for current user in a trip
router.put('/trip/:tripId/toggle', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  const { isSharing } = req.body;

  try {
    const existing = await prisma.memberLocation.findUnique({
      where: {
        tripId_userId: {
          tripId,
          userId: req.user.id
        }
      }
    });

    if (!existing) {
      return res.status(404).json({ message: 'No location record found to toggle.' });
    }

    const updated = await prisma.memberLocation.update({
      where: {
        tripId_userId: {
          tripId,
          userId: req.user.id
        }
      },
      data: {
        isSharing: Boolean(isSharing)
      }
    });

    res.json({
      message: `Location sharing ${updated.isSharing ? 'enabled' : 'disabled'}.`,
      isSharing: updated.isSharing
    });
  } catch (error) {
    console.error('Error toggling location sharing:', error);
    res.status(500).json({ message: 'Server error while toggling location sharing.' });
  }
});

// DELETE: Stop sharing and clear location for current user in trip
router.delete('/trip/:tripId', authMiddleware, tripAuthMiddleware, async (req, res) => {
  const { tripId } = req.params;
  try {
    await prisma.memberLocation.deleteMany({
      where: {
        tripId,
        userId: req.user.id
      }
    });
    res.json({ message: 'Location sharing stopped and location cleared.' });
  } catch (error) {
    console.error('Error clearing location:', error);
    res.status(500).json({ message: 'Server error while clearing location.' });
  }
});

// ==========================================
// 3. GEOCODING & PLACE SEARCH (OpenStreetMap Nominatim)
// ==========================================

// GET: Place autocomplete / search
router.get('/search', authMiddleware, async (req, res) => {
  const query = req.query.q;
  if (!query || query.trim().length < 2) {
    return res.json([]);
  }

  const encodedQuery = encodeURIComponent(query.trim());
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodedQuery}&limit=6&addressdetails=1`;

  const options = {
    headers: {
      'User-Agent': 'TripSplitPro-App/1.0 (tripsplitpro-admin@example.com)'
    }
  };

  https.get(nominatimUrl, options, (response) => {
    let data = '';
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => {
      try {
        const json = JSON.parse(data);
        const results = (json || []).map(item => ({
          name: item.name || item.display_name.split(',')[0],
          displayName: item.display_name,
          latitude: parseFloat(item.lat),
          longitude: parseFloat(item.lon),
          type: item.type || item.class || 'place'
        }));
        res.json(results);
      } catch (e) {
        console.error('Failed to parse Nominatim response:', e);
        res.json([]);
      }
    });
  }).on('error', err => {
    console.error('Nominatim request error:', err);
    res.status(500).json({ message: 'Geocoding service unavailable' });
  });
});

// ==========================================
// 4. FRIENDS NETWORK LIVE LOCATIONS
// ==========================================

// GET: Fetch all friends sharing locations across user's trips
router.get('/friends', authMiddleware, async (req, res) => {
  try {
    // Find all trips the user participates in
    const userTrips = await prisma.trip.findMany({
      where: {
        OR: [
          { creatorId: req.user.id },
          { members: { some: { userId: req.user.id } } }
        ]
      },
      select: { id: true, name: true }
    });

    const tripIds = userTrips.map(t => t.id);

    // Fetch active shared locations in those trips
    const locations = await prisma.memberLocation.findMany({
      where: {
        tripId: { in: tripIds },
        userId: { not: req.user.id },
        isSharing: true
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true
          }
        },
        trip: {
          select: {
            id: true,
            name: true,
            destination: true
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    res.json(locations);
  } catch (error) {
    console.error('Error fetching friends locations:', error);
    res.status(500).json({ message: 'Server error while fetching friends locations.' });
  }
});

module.exports = router;
