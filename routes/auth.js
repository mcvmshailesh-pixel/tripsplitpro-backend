const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_123';

// 1. REGISTER ROUTE
router.post('/register', async (req, res) => {
  try {
    const { name, email, mobile, password } = req.body;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists with this email.' });
    }

    // Hash the password securely
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Save to Database
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        mobile,
        passwordHash,
      },
    });

    // Generate JWT Token
    const token = jwt.sign({ id: newUser.id, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role, avatarUrl: newUser.avatarUrl }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during registration.' });
  }
});

// 2. LOGIN ROUTE
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find the user
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    // Generate JWT Token
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, avatarUrl: user.avatarUrl, mustChangePassword: user.mustChangePassword }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

const authMiddleware = require('../middleware/authMiddleware');

// 3. UPDATE PROFILE ROUTE
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { avatarUrl } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarUrl: true,
        mobile: true,
      }
    });

    res.json({
      message: 'Profile updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during profile update.' });
  }
});

// 4. FORGOT PASSWORD REQUEST
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ message: 'User not found with this email.' });
    }

    // Create a new request in database
    const request = await prisma.passwordResetRequest.create({
      data: {
        userId: user.id,
        status: 'PENDING'
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        action: 'PASSWORD_RESET_REQUESTED',
        userId: user.id,
        details: `Password reset request created for user ${user.name} (${user.email}). Request ID: ${request.id}`
      }
    });

    res.json({ message: 'Password reset request submitted successfully. Please contact your administrator to approve it.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during password reset request.' });
  }
});

// 5. RESET REQUEST STATUS
router.post('/reset-status', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ message: 'User not found with this email.' });
    }

    const latestRequest = await prisma.passwordResetRequest.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    });

    if (!latestRequest) {
      return res.json({ status: 'NONE', message: 'No reset requests found for this user.' });
    }

    res.json({
      status: latestRequest.status,
      createdAt: latestRequest.createdAt,
      adminNotes: latestRequest.adminNotes
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while checking request status.' });
  }
});

// 6. FORCE CHANGE PASSWORD (Authenticated, requires mustChangePassword to be true)
router.post('/change-password-forced', authMiddleware, async (req, res) => {
  const { newPassword } = req.body;
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Hash the password securely
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update password and clear force change flag
    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: false
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        action: 'PASSWORD_CHANGED_FORCED',
        userId: userId,
        details: `Forced password change completed successfully for user ${user.name} (${user.email}).`
      }
    });

    res.json({ message: 'Password changed successfully. You can now access your dashboard.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during forced password change.' });
  }
});

module.exports = router;