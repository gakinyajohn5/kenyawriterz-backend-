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

// PostgreSQL / Supabase Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'kenyawriters_secret';

// Health Check
app.get('/api/health', (req, res) => res.json({ status: "Backend API is active." }));

// AUTHENTICATION: REGISTER
app.post('/api/auth/register', async (req, res) => {
    const { fullName, email, phone, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await pool.query(
            `INSERT INTO users (full_name, email, phone, password_hash) 
             VALUES ($1, $2, $3, $4) 
             RETURNING id, full_name, email, phone, is_registered, is_premium, is_training_paid`,
            [fullName, email, phone, hashedPassword]
        );
        const user = newUser.rows[0];
        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user });
    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).json({ error: "Registration failed or email already exists." });
    }
});

// AUTHENTICATION: LOGIN
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(400).json({ error: 'User not found.' });

        const user = result.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(400).json({ error: 'Invalid password.' });

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ 
            token, 
            user: { 
                id: user.id,
                name: user.full_name, 
                email: user.email, 
                phone: user.phone,
                is_registered: user.is_registered,
                is_premium: user.is_premium,
                is_training_paid: user.is_training_paid
            } 
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: "Login failed." });
    }
});

// GET USER PROFILE / REFRESH STATUS
app.get('/api/user/status/:phone', async (req, res) => {
    try {
        const result = await pool.query('SELECT full_name, email, phone, is_registered, is_premium, is_training_paid FROM users WHERE phone = $1', [req.params.phone]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch user status." });
    }
});

// M-PESA STK PUSH (Handles Registration, Premium, and Special Training)
app.post('/api/stk-push', async (req, res) => {
    const { phone, purpose } = req.body;
    
    // Pricing logic
    let amount = 10; // Default Registration
    if (purpose === 'premium') amount = 20;
    if (purpose === 'training') amount = 30;

    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const shortCode = process.env.MPESA_SHORTCODE || "174379"; 
    const passKey = process.env.MPESA_PASSKEY;

    try {
        // 1. Generate Safaricom Token
        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const tokenReq = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            headers: { Authorization: `Basic ${auth}` }
        });
        const accessToken = tokenReq.data.access_token;

        // 2. Build Password & Payload
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64');

        let desc = "Registration";
        if (purpose === 'premium') desc = "Premium Upgrade";
        if (purpose === 'training') desc = "Special Training Masterclass";

        const stkReq = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
            BusinessShortCode: shortCode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: amount,
            PartyA: phone,
            PartyB: shortCode,
            PhoneNumber: phone,
            CallBackURL: "https://kenyawriterz-api.onrender.com/api/stk-callback",
            AccountReference: "KenyaWriters",
            TransactionDesc: desc
        }, { headers: { Authorization: `Bearer ${accessToken}` } });

        // 3. Save pending transaction in Supabase
        const checkoutRequestId = stkReq.data.CheckoutRequestID;
        await pool.query(
            `INSERT INTO transactions (checkout_request_id, phone, amount, purpose, status) VALUES ($1, $2, $3, $4, 'Pending')`,
            [checkoutRequestId, phone, amount, purpose]
        );

        res.json({ success: true, message: "Push sent successfully", data: stkReq.data });
    } catch (err) {
        console.error("STK Push Error:", err.response ? err.response.data : err.message);
        res.status(500).json({ error: "STK push failed" });
    }
});

// M-PESA CALLBACK HANDLER
app.post('/api/stk-callback', async (req, res) => {
    // Acknowledge receipt to Safaricom immediately
    res.status(200).json({ status: "Received" });

    try {
        const callbackData = req.body.Body.stkCallback;
        const checkoutRequestId = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;

        if (resultCode === 0) {
            // Payment Successful
            const metadata = callbackData.CallbackMetadata.Item;
            const receiptNumber = metadata.find(item => item.Name === 'MpesaReceiptNumber').Value;

            // 1. Update Transaction record
            const updatedTx = await pool.query(
                `UPDATE transactions SET status = 'Completed', mpesa_receipt = $1 WHERE checkout_request_id = $2 RETURNING phone, purpose`,
                [receiptNumber, checkoutRequestId]
            );

            if (updatedTx.rows.length > 0) {
                const { phone, purpose } = updatedTx.rows[0];

                // 2. Update User flags based on purpose paid
                if (purpose === 'training') {
                    await pool.query(`UPDATE users SET is_training_paid = TRUE WHERE phone = $1 OR phone = $2`, [phone, '0' + phone.slice(3)]);
                } else if (purpose === 'premium') {
                    await pool.query(`UPDATE users SET is_premium = TRUE WHERE phone = $1 OR phone = $2`, [phone, '0' + phone.slice(3)]);
                } else if (purpose === 'registration') {
                    await pool.query(`UPDATE users SET is_registered = TRUE WHERE phone = $1 OR phone = $2`, [phone, '0' + phone.slice(3)]);
                }
            }
        } else {
            // Payment Failed or Cancelled
            await pool.query(
                `UPDATE transactions SET status = 'Failed', error_message = $1 WHERE checkout_request_id = $2`,
                [callbackData.ResultDesc, checkoutRequestId]
            );
        }
    } catch (error) {
        console.error("Callback Processing Error:", error);
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
