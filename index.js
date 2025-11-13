import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const DEFAULT_DB_URL = 'https://tintaprintingfyp-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || DEFAULT_DB_URL;
const ANDROID_DEEP_LINK = process.env.ANDROID_APP_DEEP_LINK || 'tintaprinting://payment';

// -----------------------------------------------------------------------------
// Firebase Admin initialisation
// -----------------------------------------------------------------------------
let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Using Firebase service account from environment variable');
  } catch (error) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env variable');
    throw error;
  }
} else {
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    console.log('✅ Using Firebase service account from serviceAccountKey.json file');
  } else {
    console.warn('⚠️ serviceAccountKey.json not found and FIREBASE_SERVICE_ACCOUNT not set');
    console.warn('   Firebase Admin will not be initialised. Set credentials before deploying.');
  }
}

if (!admin.apps.length && serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FIREBASE_DATABASE_URL
  });
  console.log('✅ Firebase Admin initialised');
}

const db = admin.apps.length ? admin.database() : null;

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

// Parse ToyyibPay multipart callbacks manually (ToyyibPay sometimes sends multipart/form-data)
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return next();
  }

  const boundaryMatch = contentType.match(/boundary=(.+)$/i);
  if (!boundaryMatch) {
    return next();
  }

  const boundary = boundaryMatch[1];
  let rawData = '';

  req.setEncoding('utf8');
  req.on('data', chunk => {
    rawData += chunk;
  });

  req.on('end', () => {
    const formData = {};
    const parts = rawData.split(`--${boundary}`);

    parts.forEach(part => {
      if (!part.includes('Content-Disposition')) {
        return;
      }

      const nameMatch = part.match(/name="([^\"]+)"/);
      if (!nameMatch) {
        return;
      }

      const value = part.split('\r\n\r\n')[1];
      if (!value) {
        return;
      }

      const cleaned = value.replace(/\r\n--$/, '').trim();
      formData[nameMatch[1]] = cleaned;
    });

    req.body = formData;
    next();
  });

  req.on('error', err => {
    console.error('Error parsing multipart/form-data payload:', err);
    next();
  });
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(morgan('combined'));

// Serve static files (e.g. payment_return.html)
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

const paymentReturnPage = path.join(publicDir, 'payment_return.html');
app.get('/payment/return', (req, res) => {
  if (fs.existsSync(paymentReturnPage)) {
    res.sendFile(paymentReturnPage);
  } else {
    res.status(404).send('Payment return page not found');
  }
});

// -----------------------------------------------------------------------------
// Helper utilities
// -----------------------------------------------------------------------------

const STATUS_NORMALISER = {
  '1': 'success',
  '2': 'pending',
  '3': 'failed',
  success: 'success',
  pending: 'pending',
  failed: 'failed',
  failure: 'failed',
  cancelled: 'failed'
};

const ORDER_STATUS_MAP = {
  success: 'PAID',
  pending: 'PENDING_PAYMENT',
  failed: 'PAYMENT_FAILED'
};

function normaliseStatus(status) {
  if (!status) {
    return 'pending';
  }
  const key = String(status).toLowerCase();
  return STATUS_NORMALISER[key] || STATUS_NORMALISER[status] || 'pending';
}

async function findOrderByBillcode(billcode) {
  if (!db || !billcode) {
    return null;
  }

  const ordersRef = db.ref('orders');
  let snapshot = await ordersRef.orderByChild('billcode').equalTo(billcode).once('value');

  if (!snapshot.exists()) {
    snapshot = await ordersRef.orderByChild('billCode').equalTo(billcode).once('value');
  }

  if (!snapshot.exists()) {
    return null;
  }

  const orders = snapshot.val();
  const orderId = Object.keys(orders)[0];
  return {
    id: orderId,
    ...orders[orderId]
  };
}

async function findOrderFromPayments(billcode) {
  if (!db || !billcode) {
    return null;
  }
  const paymentsRef = db.ref('payments');
  let snapshot = await paymentsRef.orderByChild('billcode').equalTo(billcode).once('value');

  if (!snapshot.exists()) {
    snapshot = await paymentsRef.orderByChild('billCode').equalTo(billcode).once('value');
  }

  if (!snapshot.exists()) {
    return null;
  }

  const payments = snapshot.val();
  const paymentId = Object.keys(payments)[0];
  const payment = payments[paymentId];
  if (!payment || !payment.orderId) {
    return null;
  }

  const orderRef = db.ref(`orders/${payment.orderId}`);
  const orderSnapshot = await orderRef.once('value');
  if (!orderSnapshot.exists()) {
    return {
      id: payment.orderId,
      userId: payment.userId || null
    };
  }

  return {
    id: payment.orderId,
    ...orderSnapshot.val()
  };
}

async function savePaymentRecord(paymentData, orderId, userId) {
  if (!db) {
    throw new Error('Firebase database is not available');
  }
  if (!orderId) {
    throw new Error('Order ID is required to save payment');
  }
  if (!userId) {
    throw new Error('User ID is required to save payment');
  }

  const paymentId = paymentData.transaction_id || paymentData.paymentId || paymentData.billcode || `PAY-${Date.now()}`;
  const status = normaliseStatus(paymentData.status);
  const amount = Number(paymentData.amount ?? 0);
  const createdAt = paymentData.timestamp || new Date().toISOString();

  const record = {
    paymentId,
    orderId,
    userId,
    status,
    amount,
    paymentMethod: paymentData.payment_method || 'toyyibpay',
    createdAt,
    billcode: paymentData.billcode || null,
    billCode: paymentData.billcode || null,
    transactionId: paymentData.transaction_id || null,
    toyyibPayOrderId: paymentData.order_id || null,
    signature: paymentData.signature || null,
    rawPayload: paymentData.raw || null,
    updatedAt: new Date().toISOString()
  };

  const paymentsRef = db.ref(`payments/${paymentId}`);
  const byOrderRef = db.ref(`payments_by_order/${orderId}/${paymentId}`);

  await paymentsRef.set(record);
  await byOrderRef.set({
    paymentId,
    status,
    amount,
    createdAt,
    updatedAt: record.updatedAt
  });

  console.log(`✅ Payment ${paymentId} stored for order ${orderId}`);
  return record;
}

async function saveUnmatchedPayment(paymentData) {
  if (!db) {
    return null;
  }
  const paymentId = paymentData.transaction_id || paymentData.billcode || `UNMATCHED-${Date.now()}`;
  const ref = db.ref(`payments_unmatched/${paymentId}`);
  
  // Remove undefined values (Firebase doesn't allow them)
  const cleanData = {};
  Object.keys(paymentData).forEach(key => {
    if (paymentData[key] !== undefined && paymentData[key] !== null) {
      cleanData[key] = paymentData[key];
    }
  });
  
  await ref.set({
    ...cleanData,
    storedAt: new Date().toISOString()
  });
  console.log(`⚠️ Stored unmatched payment payload under payments_unmatched/${paymentId}`);
  return paymentId;
}

async function updateOrderStatus(orderId, status, extra = {}) {
  if (!db || !orderId) {
    return;
  }
  const orderRef = db.ref(`orders/${orderId}`);
  const adminStatusMap = {
    PENDING_PAYMENT: 'pending',
    PAID: 'approved',
    PROCESSING: 'in-progress',
    PRINTING: 'printing',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    PAYMENT_FAILED: 'pending'
  };

  const newStatus = ORDER_STATUS_MAP[status] || status;
  const adminStatus = adminStatusMap[newStatus] || newStatus;

  await orderRef.update({
    status: newStatus,
    adminStatus,
    updatedAt: new Date().toISOString(),
    ...extra
  });
  console.log(`📦 Order ${orderId} updated to ${newStatus} (admin status: ${adminStatus})`);
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Tinta Printing Backend',
    firebase: Boolean(db),
    timestamp: new Date().toISOString()
  });
});

app.post('/payment/callback', async (req, res) => {
  try {
    if (!db) {
      throw new Error('Firebase Admin is not initialised. Set service credentials.');
    }

    const payload = req.body || {};
    console.log('💳 ToyyibPay callback received:', payload);

    const billcode = (payload.billcode || payload.billCode || payload.bill_code || '').toString().trim();
    if (!billcode) {
      console.error('❌ Callback missing billcode. Payload keys:', Object.keys(payload));
      return res.status(200).json({ received: true, error: 'Missing billcode' });
    }

    const paymentStatus = payload.status || payload.statuscode || payload.billpaymentStatus || 'pending';
    const paymentData = {
      billcode,
      status: paymentStatus,
      amount: payload.amount || payload.billpaymentAmount || payload.totalAmount,
      payment_method: payload.payment_method || payload.method || 'toyyibpay',
      timestamp: payload.timestamp || payload.billpaymentTime || new Date().toISOString(),
      transaction_id: payload.transaction_id || payload.billpaymentInvoiceNo || payload.invoice_no,
      order_id: payload.order_id || payload.externalRef || payload.billExternalReferenceNo,
      signature: payload.signature,
      raw: payload
    };

    let order = await findOrderByBillcode(billcode);
    if (!order) {
      console.warn('⚠️ Order not found by billcode. Checking payments history...');
      order = await findOrderFromPayments(billcode);
    }

    let orderId = order?.id || null;
    let userId = order?.userId || order?.userID || order?.customerId || null;

    // If we don't have order yet, try to get it from order_id in payload
    if (!orderId && paymentData.order_id) {
      const potentialOrderId = paymentData.order_id.toString().trim();
      if (potentialOrderId.startsWith('ORD') || potentialOrderId.length > 10) {
        orderId = potentialOrderId;
        console.log(`ℹ️ Using order ID from payload: ${orderId}`);
        
        // Try to fetch the order to get userId
        try {
          const orderRef = db.ref(`orders/${orderId}`);
          const orderSnapshot = await orderRef.once('value');
          if (orderSnapshot.exists()) {
            const orderData = orderSnapshot.val();
            userId = orderData.userId || orderData.userID || orderData.customerId || orderData.customerID || null;
            console.log(`✅ Found order ${orderId}, userId: ${userId || 'NOT FOUND'}`);
            
            // Also check if billcode matches or needs to be updated
            if (!orderData.billcode && !orderData.billCode) {
              console.log(`ℹ️ Updating order ${orderId} with billcode ${billcode}`);
              await orderRef.update({
                billcode: billcode,
                billCode: billcode
              });
            }
          } else {
            console.warn(`⚠️ Order ${orderId} not found in database`);
          }
        } catch (fetchError) {
          console.error(`❌ Error fetching order ${orderId}:`, fetchError);
        }
      }
    }

    // Final check - if we still don't have userId, try to extract from order if we have orderId
    if (orderId && !userId) {
      console.warn(`⚠️ Order ${orderId} found but userId is missing. Attempting to save payment anyway...`);
      // We'll try to save with a placeholder and log it
    }

    if (!orderId) {
      console.warn('⚠️ Unable to resolve order ID. Saving to unmatched queue.');
      await saveUnmatchedPayment({ ...paymentData, note: 'Order ID not resolved' });
      return res.status(200).json({
        received: true,
        saved: false,
        warning: 'Order ID not resolved. Payment stored in payments_unmatched.'
      });
    }

    // If we have orderId but no userId, try one more time to get it or use a fallback
    if (!userId) {
      console.warn(`⚠️ userId is missing for order ${orderId}. Checking if we can proceed...`);
      // Try to get userId from users node if we have customer email or other identifier
      // For now, we'll save to unmatched but with orderId reference
      await saveUnmatchedPayment({ 
        ...paymentData, 
        orderId: orderId,
        note: 'Order found but userId missing' 
      });
      return res.status(200).json({
        received: true,
        saved: false,
        warning: `Order ${orderId} found but userId is missing. Payment stored in payments_unmatched with order reference.`
      });
    }

    const record = await savePaymentRecord(paymentData, orderId, userId);

    if (normaliseStatus(paymentStatus) === 'success') {
      await updateOrderStatus(orderId, 'success', {
        paymentId: record.paymentId,
        billcode,
        paymentDetails: {
          transactionId: record.transactionId,
          method: record.paymentMethod,
          amount: record.amount,
          confirmedAt: new Date().toISOString()
        }
      });
    } else if (normaliseStatus(paymentStatus) === 'failed') {
      await updateOrderStatus(orderId, 'failed', {
        paymentId: record.paymentId,
        billcode,
        paymentDetails: {
          transactionId: record.transactionId,
          method: record.paymentMethod,
          amount: record.amount,
          failedAt: new Date().toISOString()
        }
      });
    }

    return res.json({
      received: true,
      success: true,
      orderId,
      paymentId: record.paymentId,
      status: record.status
    });
  } catch (error) {
    console.error('❌ Error handling payment callback:', error);
    return res.status(500).json({
      received: true,
      success: false,
      error: error.message
    });
  }
});

app.get('/payment/callback', async (req, res) => {
  const { billcode, status, transaction_id } = req.query;
  try {
    let redirectUrl = `${ANDROID_DEEP_LINK}?billcode=${encodeURIComponent(billcode || '')}`;
    if (status) {
      redirectUrl += `&status=${encodeURIComponent(status)}`;
    }
    if (transaction_id) {
      redirectUrl += `&transactionId=${encodeURIComponent(transaction_id)}`;
    }

    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Redirect error:', error);
    res.redirect(`${ANDROID_DEEP_LINK}?error=callback_redirect_failed`);
  }
});

app.get('/', (req, res) => {
  res.json({
    message: 'Tinta Printing Backend is running',
    health: `${BACKEND_URL}/health`,
    callback: `${BACKEND_URL}/payment/callback`
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

app.listen(PORT, () => {
  console.log('='.repeat(72));
  console.log(`🚀 Tinta Printing backend running on port ${PORT}`);
  console.log(`🌐 Base URL: ${BACKEND_URL}`);
  console.log(`💾 Firebase URL: ${FIREBASE_DATABASE_URL}`);
  console.log(`📱 Android deep link: ${ANDROID_DEEP_LINK}`);
  console.log(`💳 ToyyibPay callback endpoint: ${BACKEND_URL}/payment/callback`);
  console.log('='.repeat(72));
});
