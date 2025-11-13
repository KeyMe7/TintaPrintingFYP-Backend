/**
 * Tinta Printing Backend Server
 * Main server file that handles ToyyibPay callbacks and admin operations
 * 
 * IMPORTANT: This server uses the payment-callback.js router which
 * automatically saves payments to Firebase when ToyyibPay sends callbacks.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Import route handlers - THESE HANDLE PAYMENT SAVING
const paymentCallback = require('./payment-callback');
const adminApi = require('./admin-api');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet()); // Security headers
app.use(cors({
  origin: [
    process.env.ADMIN_DASHBOARD_URL,
    process.env.ANDROID_APP_DEEP_LINK,
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:10000'
  ],
  credentials: true
}));
app.use(morgan('combined')); // Logging
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Test endpoint for ToyyibPay callback reachability
app.get('/test-callback', (req, res) => {
  res.json({
    message: '✅ Server is running fine - ToyyibPay callback endpoint is reachable',
    callbackUrl: `${req.protocol}://${req.get('host')}/payment/callback`,
    timestamp: new Date().toISOString()
  });
});

// Serve static files from public/ (for payment_return.html)
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

// Payment return page - serves the HTML that redirects to app
app.get('/payment/return', (req, res) => {
  const filePath = path.join(publicPath, 'payment_return.html');
  
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({
      status: 'error',
      message: 'Payment return page not found'
    });
  }
});

// Root route
app.get('/', (req, res) => {
  res.send('TintaPrintingFYP Backend is running 🚀');
});

// ⭐ IMPORTANT: API Routes - These handle payment callbacks and SAVE TO FIREBASE
// The payment-callback.js router will:
// 1. Receive ToyyibPay callbacks
// 2. Find the order by billcode
// 3. Save payment to Firebase payments node
// 4. Update order status
app.use('/', paymentCallback);
app.use('/', adminApi);

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Tinta Printing Backend Server running on port ${PORT}`);
  console.log(`📱 Admin Dashboard: ${process.env.ADMIN_DASHBOARD_URL || 'Not set'}`);
  console.log(`🔗 Android Deep Link: ${process.env.ANDROID_APP_DEEP_LINK || 'Not set'}`);
  console.log(`💳 ToyyibPay Callback: ${process.env.BACKEND_URL || `http://localhost:${PORT}`}/payment/callback`);
  console.log(`✅ Payment callback handler is ACTIVE and will save payments to Firebase`);
  console.log(`📝 Check logs for: "✅ Payment {paymentId} saved successfully" when callbacks arrive`);
});

module.exports = app;
