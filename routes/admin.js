const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

// Ensure all routes in this file require both authentication and admin role
router.use(authMiddleware);
router.use(adminMiddleware);

// ==========================================
// 1. USER MANAGEMENT ENDPOINTS
// ==========================================

// GET: Fetch all users
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        mobile: true,
        upiId: true,
        avatarUrl: true,
        role: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching users' });
  }
});

// PUT: Modify user details
router.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, mobile, upiId, role, avatarUrl } = req.body;
  try {
    // Check if email is being updated and is already taken
    if (email) {
      const existingUser = await prisma.user.findFirst({
        where: { email, NOT: { id } }
      });
      if (existingUser) {
        return res.status(400).json({ message: 'Email address is already in use by another user.' });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        name,
        email,
        mobile,
        upiId,
        role,
        avatarUrl,
      },
      select: {
        id: true,
        name: true,
        email: true,
        mobile: true,
        upiId: true,
        role: true,
        avatarUrl: true,
      }
    });

    res.json({ message: 'User updated successfully', user: updatedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while updating user' });
  }
});

// DELETE: Delete a user and cascade related records safely
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  
  if (id === req.user.id) {
    return res.status(400).json({ message: 'You cannot delete your own admin account.' });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Delete settlements involving the user
      await tx.settlement.deleteMany({
        where: { OR: [{ payerId: id }, { payeeId: id }] }
      });

      // 2. Delete expense shares corresponding to the user
      await tx.expenseShare.deleteMany({
        where: { userId: id }
      });

      // 3. Delete expenses paid by this user
      await tx.expense.deleteMany({
        where: { paidById: id }
      });

      // 4. Delete trip member entries for this user
      await tx.tripMember.deleteMany({
        where: { userId: id }
      });

      // 5. Delete friendships involving this user
      await tx.friendship.deleteMany({
        where: { OR: [{ userId: id }, { friendId: id }] }
      });

      // 6. Delete all trips created by the user, cascading their internal members/expenses
      const userTrips = await tx.trip.findMany({
        where: { creatorId: id },
        select: { id: true }
      });
      
      const tripIds = userTrips.map(t => t.id);
      if (tripIds.length > 0) {
        await tx.settlement.deleteMany({ where: { tripId: { in: tripIds } } });
        await tx.expense.deleteMany({ where: { tripId: { in: tripIds } } });
        await tx.tripMember.deleteMany({ where: { tripId: { in: tripIds } } });
        await tx.trip.deleteMany({ where: { creatorId: id } });
      }

      // 7. Finally delete the user account
      await tx.user.delete({
        where: { id }
      });
    });

    res.json({ message: 'User and all associated activities deleted successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while deleting user.' });
  }
});

// ==========================================
// 2. TRIP MANAGEMENT ENDPOINTS
// ==========================================

// GET: Fetch all trips
router.get('/trips', async (req, res) => {
  try {
    const trips = await prisma.trip.findMany({
      include: {
        creator: {
          select: { id: true, name: true, email: true }
        },
        members: {
          include: {
            user: { select: { id: true, name: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(trips);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching trips' });
  }
});

// PUT: Modify a trip
router.put('/trips/:id', async (req, res) => {
  const { id } = req.params;
  const { name, destination, startDate, endDate, currency, description } = req.body;
  try {
    const updatedTrip = await prisma.trip.update({
      where: { id },
      data: {
        name,
        destination,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        currency,
        description,
      }
    });
    res.json({ message: 'Trip updated successfully', trip: updatedTrip });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while updating trip' });
  }
});

// DELETE: Delete a trip
router.delete('/trips/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.trip.delete({
      where: { id }
    });
    res.json({ message: 'Trip deleted successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while deleting trip.' });
  }
});

// ==========================================
// 3. EXPENSE MANAGEMENT ENDPOINTS
// ==========================================

// GET: Fetch all expenses
router.get('/expenses', async (req, res) => {
  try {
    const expenses = await prisma.expense.findMany({
      include: {
        paidBy: {
          select: { id: true, name: true, email: true }
        },
        trip: {
          select: { id: true, name: true }
        }
      },
      orderBy: { date: 'desc' }
    });
    res.json(expenses);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching expenses' });
  }
});

// PUT: Modify an expense
router.put('/expenses/:id', async (req, res) => {
  const { id } = req.params;
  const { description, amount, category, date } = req.body;
  try {
    const updatedExpense = await prisma.expense.update({
      where: { id },
      data: {
        description,
        amount: amount ? parseFloat(amount) : undefined,
        category,
        date: date ? new Date(date) : undefined,
      }
    });
    res.json({ message: 'Expense updated successfully', expense: updatedExpense });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while updating expense' });
  }
});

// DELETE: Delete an expense
router.delete('/expenses/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.expense.delete({
      where: { id }
    });
    res.json({ message: 'Expense deleted successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while deleting expense.' });
  }
});

// ==========================================
// 4. CATEGORY MANAGEMENT ENDPOINTS
// ==========================================

// GET: Fetch all categories
router.get('/categories', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isDeleted: false },
      orderBy: { sortOrder: 'asc' }
    });
    res.json(categories);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching categories' });
  }
});

// POST: Add a Category
router.post('/categories', async (req, res) => {
  const { name, icon, color, sortOrder, isEnabled } = req.body;
  try {
    const existing = await prisma.category.findUnique({ where: { name } });
    if (existing) {
      if (existing.isDeleted) {
        // Reactivate soft-deleted category
        const updated = await prisma.category.update({
          where: { id: existing.id },
          data: { isDeleted: false, isEnabled: true, icon, color, sortOrder: parseInt(sortOrder) || 0 }
        });
        return res.status(201).json({ message: 'Category created successfully', category: updated });
      }
      return res.status(400).json({ message: 'Category already exists' });
    }

    const category = await prisma.category.create({
      data: {
        name,
        icon: icon || 'folder',
        color: color || '#6c757d',
        sortOrder: parseInt(sortOrder) || 0,
        isEnabled: isEnabled !== undefined ? isEnabled : true
      }
    });

    await prisma.auditLog.create({
      data: {
        action: 'CATEGORY_CREATED',
        userId: req.user.id,
        details: `Created category ${name}`
      }
    });

    res.status(201).json({ message: 'Category created successfully', category });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while creating category' });
  }
});

// PUT: Modify Category details
router.put('/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { name, icon, color, sortOrder, isEnabled } = req.body;
  try {
    if (name) {
      const existing = await prisma.category.findFirst({
        where: { name, NOT: { id } }
      });
      if (existing) {
        return res.status(400).json({ message: 'Category name is already in use.' });
      }
    }

    const updated = await prisma.category.update({
      where: { id },
      data: {
        name,
        icon,
        color,
        sortOrder: sortOrder !== undefined ? parseInt(sortOrder) : undefined,
        isEnabled
      }
    });

    await prisma.auditLog.create({
      data: {
        action: 'CATEGORY_UPDATED',
        userId: req.user.id,
        details: `Updated category ${name || updated.name}`
      }
    });

    res.json({ message: 'Category updated successfully', category: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while updating category' });
  }
});

// DELETE: Delete a Category (soft-delete with linked expense check)
router.delete('/categories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) {
      return res.status(404).json({ message: 'Category not found.' });
    }

    // Prevent deletion if category has linked expenses
    const linkedExpense = await prisma.expense.findFirst({
      where: { category: category.name }
    });

    if (linkedExpense) {
      return res.status(400).json({
        message: 'Cannot delete category. It is linked to existing expenses. You can disable it instead.'
      });
    }

    // Soft delete instead of permanent delete
    await prisma.category.update({
      where: { id },
      data: { isDeleted: true, isEnabled: false }
    });

    await prisma.auditLog.create({
      data: {
        action: 'CATEGORY_DELETED',
        userId: req.user.id,
        details: `Soft-deleted category ${category.name}`
      }
    });

    res.json({ message: 'Category deleted successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while deleting category' });
  }
});


// ==========================================
// 5. PASSWORD RESET REQUEST MANAGEMENT
// ==========================================

// GET: Fetch all password reset requests
router.get('/reset-requests', async (req, res) => {
  try {
    const requests = await prisma.passwordResetRequest.findMany({
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(requests);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching reset requests.' });
  }
});

// POST: Resolve a password reset request (Approve/Reject)
const bcrypt = require('bcryptjs');
router.post('/reset-requests/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { status, tempPassword, forceChange, adminNotes } = req.body; // status: 'APPROVED' or 'REJECTED'
  try {
    const request = await prisma.passwordResetRequest.findUnique({
      where: { id },
      include: { user: true }
    });

    if (!request) {
      return res.status(404).json({ message: 'Password reset request not found.' });
    }

    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: 'This request has already been resolved.' });
    }

    if (status === 'APPROVED') {
      if (!tempPassword) {
        return res.status(400).json({ message: 'A temporary password is required for approval.' });
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(tempPassword, salt);

      // Update user password and force change status
      await prisma.user.update({
        where: { id: request.userId },
        data: {
          passwordHash,
          mustChangePassword: forceChange === true
        }
      });

      // Create notification for the user
      await prisma.notification.create({
        data: {
          userId: request.userId,
          title: 'Password Reset Approved',
          message: `Your password reset request has been approved. Use temporary password: "${tempPassword}". ${forceChange ? "You must change your password on next login." : ""}`,
          type: 'SUCCESS'
        }
      });
    } else {
      // Create rejection notification
      await prisma.notification.create({
        data: {
          userId: request.userId,
          title: 'Password Reset Rejected',
          message: `Your password reset request has been rejected. Reason: ${adminNotes || 'None provided'}`,
          type: 'WARNING'
        }
      });
    }

    // Update request status
    const updatedRequest = await prisma.passwordResetRequest.update({
      where: { id },
      data: {
        status,
        adminNotes
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        action: status === 'APPROVED' ? 'PASSWORD_RESET_APPROVED' : 'PASSWORD_RESET_REJECTED',
        userId: req.user.id,
        details: `Resolved password reset request ${id} for user ${request.user.email} as ${status}. Forced change: ${forceChange}`
      }
    });

    res.json({ message: `Password reset request has been ${status.toLowerCase()} successfully.`, request: updatedRequest });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while resolving reset request.' });
  }
});


// ==========================================
// 6. AUDIT LOG VIEWER
// ==========================================

// GET: Fetch recent audit logs
router.get('/audit-logs', async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    res.json(logs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching audit logs.' });
  }
});

module.exports = router;
