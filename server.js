const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

 const CONSUMER_KEY    = 'D13MnucwKpPtCY4lVwBrIAGS7pXhTVnnQSs1gKAtYxIfdN22';
const CONSUMER_SECRET = 'vrDCe22Xk8SuM0jt067zwGGDxGP86w6KcWeXS5NkJ0X7vp3ZeNw9wcHR6hXHkm6V';
const SHORTCODE       = '174379';
const PASSKEY         = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const CALLBACK_URL    = 'https://uniquely-triceps-excavate.ngrok-free.dev/mpesa/callback';

// Sandbox base URL — change to https://api.safaricom.co.ke for production
const BASE_URL = 'https://sandbox.safaricom.co.ke';

// Store pending transactions in memory (use a DB in production)
const transactions = {};

// --- Step 1: Get OAuth Token ---
async function getToken() {
  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  });
  return res.data.access_token;
}

// --- Step 2: Initiate STK Push ---
app.post('/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount, orderId } = req.body;

    // Format phone: 0712345678 → 254712345678
    const formattedPhone = phone.replace(/^0/, '254').replace(/\s/g, '');

    const token     = await getToken();
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const password  = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',  // or 'CustomerBuyGoodsOnline' for till
      Amount:            Math.ceil(amount),
      PartyA:            formattedPhone,
      PartyB:            SHORTCODE,
      PhoneNumber:       formattedPhone,
      CallBackURL:       CALLBACK_URL,
      AccountReference:  `Order-${orderId}`,
      TransactionDesc:   'ShopMix Payment'
    };

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutRequestId = response.data.CheckoutRequestID;

    // Save pending transaction
    transactions[checkoutRequestId] = { status: 'pending', orderId };

    res.json({ success: true, checkoutRequestId });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ success: false, error: 'STK push failed' });
  }
});

// --- Step 3: Safaricom hits this with the result ---
app.post('/mpesa/callback', (req, res) => {
  const body = req.body?.Body?.stkCallback;

  if (!body) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;

  if (ResultCode === 0) {
    // Payment successful
    const meta  = CallbackMetadata.Item;
    const amount = meta.find(i => i.Name === 'Amount')?.Value;
    const mpesaRef = meta.find(i => i.Name === 'MpesaReceiptNumber')?.Value;

    transactions[CheckoutRequestID] = {
      status: 'success',
      amount,
      mpesaRef
    };
    console.log('Payment received:', mpesaRef, 'Amount:', amount);
  } else {
    transactions[CheckoutRequestID] = { status: 'failed', reason: ResultDesc };
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// --- Step 4: Frontend polls this to check payment status ---
app.get('/mpesa/status/:checkoutRequestId', (req, res) => {
  const tx = transactions[req.params.checkoutRequestId];
  if (!tx) return res.json({ status: 'pending' });
  res.json(tx);
});

app.listen(3000, () => console.log('Server running on port 3000'));