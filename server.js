const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'kenyawriters_secret';

// Health Check
app.get('/api/health', (req, res) => res.json({ status: "Backend API is active." }));

// Authentication
app.post('/api/auth/register', async (req, res) => {
    const { fullName, email, phone, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        // Note: Ensure your users table exists in Supabase
        const newUser = await pool.query(
            `INSERT INTO users (full_name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, full_name, email, phone`,
            [fullName, email, phone, hashedPassword]
        );
        const user = newUser.rows[0];
        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user });
    } catch (err) {
        res.status(500).json({ error: "Registration failed or email exists." });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(400).json({ error: 'User not found.' });

        const user = result.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(400).json({ error: 'Invalid password.' });

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { name: user.full_name, email: user.email, phone: user.phone } });
    } catch (err) {
        res.status(500).json({ error: "Login failed." });
    }
});

// M-Pesa STK Push (Buy Goods)
app.post('/api/stk-push', async (req, res) => {
    const { phone, purpose } = req.body;
    const amount = purpose === 'premium' ? 20 : 10;
    
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const shortCode = process.env.MPESA_SHORTCODE || "174379"; 
    const passKey = process.env.MPESA_PASSKEY;

    try {
        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const tokenReq = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            headers: { Authorization: `Basic ${auth}` }
        });
        const accessToken = tokenReq.data.access_token;

        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64');

        const stkReq = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
            BusinessShortCode: shortCode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerBuyGoodsOnline", // Mandatory for Buy Goods Tills
            Amount: amount,
            PartyA: phone,
            PartyB: shortCode,
            PhoneNumber: phone,
            CallBackURL: "https://kenyawriterz-api.onrender.com/api/stk-callback",
            AccountReference: "KenyaWriters",
            TransactionDesc: purpose === 'premium' ? "Premium Activation" : "Registration"
        }, { headers: { Authorization: `Bearer ${accessToken}` } });

        res.json({ success: true, message: "Push sent", data: stkReq.data });
    } catch (err) {
        res.status(500).json({ error: "STK push failed" });
    }
});

// M-Pesa Callback
app.post('/api/stk-callback', (req, res) => res.status(200).json({ status: "Received" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Live on port ${PORT}`));
