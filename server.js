const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Health Check Route
app.get('/api/health', (req, res) => {
    res.json({ status: "Backend API is active and healthy." });
});

// STK Push Route for Till Number 1734136 (Buy Goods)
app.post('/api/stk-push', async (req, res) => {
    const { phone, purpose } = req.body; // phone: 2547XXXXXXXX, purpose: 'register' or 'premium'

    // Dynamic testing amounts
    let amount = 10; // Default registration fee
    if (purpose === 'premium') {
        amount = 20; // Premium account upgrade fee
    }

    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const shortCode = "1734136"; // Your Buy Goods Till Number
    const passKey = process.env.MPESA_PASSKEY;
    const callbackUrl = "https://kenyawriterz-api.onrender.com/api/stk-callback";

    try {
        // 1. Generate OAuth Access Token from Safaricom Daraja
        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const tokenResponse = await axios.get(
            'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            { headers: { Authorization: `Basic ${auth}` } }
        );
        const accessToken = tokenResponse.data.access_token;

        // 2. Generate Timestamp & Security Password
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64');

        // 3. Send STK Push Request (CustomerBuyGoodsOnline is mandatory for Till Numbers)
        const stkResponse = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: shortCode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: "CustomerBuyGoodsOnline", // Mandatory for Till numbers
                Amount: amount,                             // 10 KES or 20 KES
                PartyA: phone,
                PartyB: shortCode,                          // PartyB is your store/till number for Buy Goods
                PhoneNumber: phone,
                CallBackURL: callbackUrl,
                AccountReference: "KenyaWriters",
                TransactionDesc: purpose === 'premium' ? "Premium Activation" : "Account Registration"
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        res.json({ success: true, message: `STK push of KSH ${amount} sent successfully.`, data: stkResponse.data });
    } catch (err) {
        console.error("STK Push Error:", err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || "Failed to initiate STK push" });
    }
});

// M-Pesa Callback Endpoint
app.post('/api/stk-callback', (req, res) => {
    const callbackData = req.body.Body.stkCallback;
    
    if (callbackData.ResultCode === 0) {
        console.log("Payment successful:", callbackData.CallbackMetadata);
        // Payment success logic goes here
    } else {
        console.log("Payment failed or cancelled:", callbackData.ResultDesc);
    }

    res.status(200).json({ status: "Received" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
