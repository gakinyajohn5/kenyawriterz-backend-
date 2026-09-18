// STK Push Route for Till Number 1734136 (Buy Goods)
app.post('/api/stk-push', async (req, res) => {
    const { phone, purpose } = req.body; // phone: 2547XXXXXXXX, purpose: 'register' or 'premium'

    // Dynamic pricing based on user action
    let amount = 10; // Default registration fee (KSH 10)
    if (purpose === 'premium') {
        amount = 20; // Premium account activation fee (KSH 20)
    }

    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    
    // Use sandbox shortcode '174379' for testing, or your live till '1734136' when ready
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
                PartyB: shortCode,                          // Till store number
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
