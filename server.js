// STK Push Route for M-Pesa (Buy Goods / Till Number)
app.post('/api/stk-push', async (req, res) => {
    const { phone, purpose } = req.body; // purpose: 'register' (10 KES) or 'premium' (20 KES)

    let amount = 10; // Default registration fee
    if (purpose === 'premium') {
        amount = 20; // Premium account upgrade fee
    }

    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    
    // Use sandbox shortcode '174379' for testing, replace with '1734136' when live
    const shortCode = process.env.MPESA_SHORTCODE || "174379"; 
    const passKey = process.env.MPESA_PASSKEY;
    const callbackUrl = "https://kenyawriterz-api.onrender.com/api/stk-callback";

    try {
        // 1. Generate OAuth Access Token
        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const tokenResponse = await axios.get(
            'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            { headers: { Authorization: `Basic ${auth}` } }
        );
        const accessToken = tokenResponse.data.access_token;

        // 2. Generate Timestamp & Password
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
                PartyB: shortCode,                          // Till store number
                PhoneNumber: phone,
                CallBackURL: callbackUrl,
                AccountReference: "KenyaWriters",
                TransactionDesc: purpose === 'premium' ? "Premium Activation" : "Registration"
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        res.json({ success: true, message: `STK push of KSH ${amount} sent.`, data: stkResponse.data });
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
        // TODO: Update user status in database here
    }
    res.status(200).json({ status: "Received" });
});
