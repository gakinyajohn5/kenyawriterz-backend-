const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET || 'kenyawriters_super_secret_key';

// Health Check Route
app.get('/api/health', (req, res) => {
    res.json({ status: "Backend API is active and healthy." });
});

// Authentication Routes
app.post('/api/auth/register', async (req, res) => {
    const { fullName, email, phone, password } = req.body;
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) return res.status(400).json({ error: 'Email already registered.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await pool.query(
            `INSERT INTO users (full_name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, full_name, email, phone, account_tier`,
            [fullName, email, phone, hashedPassword]
        );
        const user = newUser.rows[0];
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ message: 'Registration successful', token, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(400).json({ error: 'User not found.' });

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(400).json({ error: 'Invalid password.' });

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            message: 'Login successful',
            token,
            user: { id: user.id, name: user.full_name, email: user.email, phone: user.phone, tier: user.account_tier }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fetch Tasks Route
app.get('/api/tasks', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM tasks WHERE status = 'available' ORDER BY created_at DESC LIMIT 50");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// M-Pesa STK Push Route for Till Number 1734136 (Buy Goods)
app.post('/api/stk-push', async (req, res) => {
    const { phone, purpose } = req.body; // purpose: 'register' (10 KES) or 'premium' (20 KES)

    // Dynamic pricing setup
    let amount = 10; // Default registration fee
    if (purpose === 'premium') {
        amount = 20; // Premium account activation fee
    }

    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    
    // Use sandbox shortcode '174379' for sandbox testing, or '1734136' when live production credentials are active
    const shortCode = process.env.MPESA_SHORTCODE || "174379"; 
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
                TransactionType: "CustomerBuyGoodsOnline", // Mandatory for Buy Goods Tills
                Amount: amount,                             // 10 KES or 20 KES
                PartyA: phone,
                PartyB: shortCode,                          // Store / Till number
                PhoneNumber: phone,
                CallBackURL: callbackUrl,
                AccountReference: "KenyaWriters",
                TransactionDesc: purpose === 'premium' ? "Premium Activation" : "Registration"
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
        // TODO: Update user to verified/premium status in Supabase database here
    } else {
        console.log("Payment failed or cancelled:", callbackData.ResultDesc);
    }

    res.status(200).json({ status: "Received" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
