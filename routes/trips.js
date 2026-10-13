const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/authMiddleware'); // Import the Bouncer

const router = express.Router();
const prisma = new PrismaClient();

// POST: Create a new trip (Protected)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, destination, startDate, endDate, currency, budget } = req.body;

    // Save the trip to PostgreSQL and link it to the logged-in user
    const newTrip = await prisma.trip.create({
      data: {
        name,
        destination,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        currency: currency || 'INR',
        creatorId: req.user.id, // We get this from the JWT token!
        budget: budget ? parseFloat(budget) : null
      },
    });

    res.status(201).json({ message: 'Trip created successfully', trip: newTrip });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while creating trip' });
  }
});

// GET: Fetch all trips for the logged-in user (Protected)
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Find trips where the user is either the creator OR a tagged member
    const trips = await prisma.trip.findMany({
      where: {
        OR: [
          { creatorId: req.user.id },
          { members: { some: { userId: req.user.id } } }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(trips);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching trips' });
  }
});

// GET: Fetch all users in the system to add as members (Protected)
router.get('/available-users', authMiddleware, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        NOT: { id: req.user.id }
      },
      select: {
        id: true,
        name: true,
        email: true
      },
      orderBy: { name: 'asc' }
    });
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching available users' });
  }
});

// POST: Add a friend to a trip by Email (Protected)
router.post('/:tripId/members', authMiddleware, async (req, res) => {
  try {
    const { tripId } = req.params;
    const { email } = req.body;

    // 1. Find the friend by their email
    const friend = await prisma.user.findUnique({ where: { email } });
    if (!friend) {
      return res.status(404).json({ message: 'No user found with this email.' });
    }

    // 2. Verify the trip exists and the person requesting is the Creator
    const trip = await prisma.trip.findUnique({ 
      where: { id: tripId },
      include: { members: true } 
    });

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found.' });
    }
    
    if (trip.creatorId !== req.user.id) {
      return res.status(403).json({ message: 'Only the trip creator can add members.' });
    }

    // 3. Check if they are already in the trip
    const isAlreadyMember = trip.members.some(member => member.userId === friend.id);
    if (isAlreadyMember || friend.id === trip.creatorId) {
      return res.status(400).json({ message: 'User is already in this trip.' });
    }

    // 4. Add the friend to the trip
    await prisma.tripMember.create({
      data: {
        tripId: tripId,
        userId: friend.id
      }
    });

    res.status(201).json({ message: `${friend.name} has been added to the trip!` });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while adding member.' });
  }
});

// GET: Fetch dashboard summary statistics (Protected)
router.get('/dashboard/summary', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Find all trips where the user is creator or member
    const trips = await prisma.trip.findMany({
      where: {
        OR: [
          { creatorId: userId },
          { members: { some: { userId } } }
        ]
      },
      include: {
        expenses: {
          include: { payers: true, shares: true }
        },
        advances: {
          where: { status: 'APPROVED' }
        },
        pettyCash: true,
        settlements: {
          where: { status: 'COMPLETED' }
        },
        members: {
          include: { user: { select: { id: true, name: true } } }
        },
        creator: { select: { id: true, name: true } }
      }
    });

    let totalBudget = 0;
    let totalExpenses = 0;
    let totalAdvances = 0;
    let cashInHand = 0;
    let amountRecoverable = 0;
    let amountPayable = 0;
    const categoryBreakdown = {};
    const tripCosts = []; 
    const recentTransactions = [];

    // Loop through each trip to calculate balances
    for (const trip of trips) {
      if (trip.budget) totalBudget += trip.budget;

      // 1. Unique participants
      const participants = new Set();
      participants.add(trip.creatorId);
      trip.members.forEach(m => participants.add(m.userId));

      // 2. Stats structure
      const stats = {};
      participants.forEach(pid => {
        stats[pid] = { totalPaid: 0, totalOwed: 0 };
      });

      // 3. Process expenses
      trip.expenses.forEach(exp => {
        // Track recent transactions
        recentTransactions.push({
          id: exp.id,
          tripName: trip.name,
          tripId: trip.id,
          description: exp.description,
          amount: exp.amount,
          date: exp.date,
          category: exp.category
        });

        // Add to category breakdown
        if (exp.category !== 'Payment') {
          totalExpenses += exp.amount;
          categoryBreakdown[exp.category] = (categoryBreakdown[exp.category] || 0) + exp.amount;
        }

        // Payers
        if (exp.payers && exp.payers.length > 0) {
          exp.payers.forEach(p => {
            if (stats[p.userId]) stats[p.userId].totalPaid += p.amountPaid;
          });
        } else {
          if (stats[exp.paidById]) stats[exp.paidById].totalPaid += exp.amount;
        }

        // Shares
        if (exp.shares && exp.shares.length > 0) {
          exp.shares.forEach(s => {
            if (stats[s.userId]) stats[s.userId].totalOwed += s.amountOwed;
          });
        } else {
          const shareAmt = exp.amount / participants.size;
          participants.forEach(pid => {
            if (stats[pid]) stats[pid].totalOwed += shareAmt;
          });
        }
      });

      // 4. Process Advances
      trip.advances.forEach(adv => {
        totalAdvances += adv.amount;
        if (stats[adv.userId]) stats[adv.userId].totalPaid += adv.amount;
        if (stats[trip.creatorId]) stats[trip.creatorId].totalPaid -= adv.amount;
      });

      // 5. Process Petty Cash
      trip.pettyCash.forEach(tx => {
        if (tx.cashHolderId === userId) {
          cashInHand += tx.amountAdded - tx.amountWithdrawn;
        }
        if (tx.fundedById && stats[tx.fundedById]) {
          stats[tx.fundedById].totalPaid += tx.amountAdded;
        }
        if (tx.expenseId && stats[tx.cashHolderId]) {
          stats[tx.cashHolderId].totalPaid -= tx.amountWithdrawn;
        }
      });

      // 6. Process Settlements
      trip.settlements.forEach(set => {
        if (stats[set.payerId]) stats[set.payerId].totalPaid += set.amount;
        if (stats[set.payeeId]) stats[set.payeeId].totalPaid -= set.amount;
      });

      // 7. Calculate user's specific balance in this trip
      const userStats = stats[userId];
      let userBalance = 0;
      if (userStats) {
        userBalance = userStats.totalPaid - userStats.totalOwed;
        if (userBalance > 0) {
          amountRecoverable += userBalance;
        } else if (userBalance < 0) {
          amountPayable += Math.abs(userBalance);
        }
      }

      // Calculate total trip cost
      const tripCost = trip.expenses
        .filter(e => e.category !== 'Payment')
        .reduce((sum, e) => sum + e.amount, 0);
      
      tripCosts.push({
        id: trip.id,
        name: trip.name,
        cost: tripCost,
        budget: trip.budget,
        status: trip.status,
        destination: trip.destination,
        startDate: trip.startDate,
        endDate: trip.endDate,
        userBalance
      });
    }

    // Sort recent transactions by date descending, take top 5
    recentTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    const recent = recentTransactions.slice(0, 5);

    res.json({
      totalBudget,
      totalExpenses,
      totalAdvances,
      cashInHand,
      amountRecoverable,
      amountPayable,
      categoryBreakdown,
      tripCosts,
      recentTransactions: recent
    });

  } catch (error) {
    console.error('Error in dashboard summary:', error);
    res.status(500).json({ message: 'Server error while loading summary stats.' });
  }
});

// GET: Fetch a single trip by ID (Protected, checks trip membership)
router.get('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const trip = await prisma.trip.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, name: true, email: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
        destinations: { orderBy: [{ order: 'asc' }, { plannedDate: 'asc' }, { createdAt: 'asc' }] },
        memberLocations: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } }
      }
    });

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    const isCreator = trip.creatorId === req.user.id;
    const isMember = trip.members.some(m => m.userId === req.user.id);
    const isAdmin = req.user.role === 'ADMIN';

    if (!isCreator && !isMember && !isAdmin) {
      return res.status(403).json({ message: 'Access denied. You are not a member of this trip.' });
    }

    res.json(trip);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching trip details.' });
  }
});

// PUT: Modify a trip (Protected, creator or admin only)
router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, destination, startDate, endDate, currency, budget, status, description } = req.body;
  try {
    const trip = await prisma.trip.findUnique({ where: { id } });
    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    const isCreator = trip.creatorId === req.user.id;
    const isAdmin = req.user.role === 'ADMIN';

    if (!isCreator && !isAdmin) {
      return res.status(403).json({ message: 'Only the trip creator or an administrator can modify this trip.' });
    }

    const updatedTrip = await prisma.trip.update({
      where: { id },
      data: {
        name,
        destination,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        currency,
        budget: budget !== undefined ? (budget ? parseFloat(budget) : null) : undefined,
        status,
        description
      }
    });

    // Notify members if trip status is modified (e.g. CLOSED)
    if (status && status !== trip.status) {
      const tripMembers = await prisma.tripMember.findMany({ where: { tripId: id } });
      const notifyPromises = tripMembers
        .filter(m => m.userId !== req.user.id)
        .map(m => prisma.notification.create({
          data: {
            userId: m.userId,
            title: `Trip ${status === 'CLOSED' ? 'Closed' : 'Reopened'} 🌴`,
            message: `The trip "${trip.name}" has been ${status.toLowerCase()} by the organizer.`,
            type: 'INFO'
          }
        }));
      await Promise.all(notifyPromises);
    }

    res.json({ message: 'Trip updated successfully', trip: updatedTrip });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while updating trip' });
  }
});

module.exports = router;