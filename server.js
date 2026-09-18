// M-Pesa STK Push
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
            // NOTE: Sandbox shortcode 174379 is a Paybill. You must use CustomerPayBillOnline for testing.
            TransactionType: "CustomerPayBillOnline", 
            Amount: amount,
            PartyA: phone,
            PartyB: shortCode,
            PhoneNumber: phone,
            CallBackURL: "https://kenyawriterz-api.onrender.com/api/stk-callback",
            AccountReference: "KenyaWriters",
            TransactionDesc: purpose === 'premium' ? "Premium Activation" : "Registration"
        }, { headers: { Authorization: `Bearer ${accessToken}` } });

        // IMPORTANT: Save the pending transaction to Supabase so the callback can find it
        const checkoutRequestId = stkReq.data.CheckoutRequestID;
        await pool.query(
            `INSERT INTO transactions (checkout_request_id, phone, amount, purpose, status) VALUES ($1, $2, $3, $4, 'Pending')`,
            [checkoutRequestId, phone, amount, purpose]
        );

        res.json({ success: true, message: "Push sent to phone", data: stkReq.data });
    } catch (err) {
        console.error(err.response ? err.response.data : err.message);
        res.status(500).json({ error: "STK push failed" });
    }
});

// M-Pesa Callback
app.post('/api/stk-callback', async (req, res) => {
    // 1. Immediately acknowledge receipt to Safaricom
    res.status(200).json({ status: "Received" });

    // 2. Process the data in the background
    try {
        const callbackData = req.body.Body.stkCallback;
        const checkoutRequestId = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;

        if (resultCode === 0) {
            // Payment was successful (User entered PIN)
            const metadata = callbackData.CallbackMetadata.Item;
            const receiptNumber = metadata.find(item => item.Name === 'MpesaReceiptNumber').Value;

            await pool.query(
                `UPDATE transactions SET status = 'Completed', mpesa_receipt = $1 WHERE checkout_request_id = $2`,
                [receiptNumber, checkoutRequestId]
            );
        } else {
            // Payment failed or was cancelled by user
            await pool.query(
                `UPDATE transactions SET status = 'Failed', error_message = $1 WHERE checkout_request_id = $2`,
                [callbackData.ResultDesc, checkoutRequestId]
            );
        }
    } catch (error) {
        console.error("Error processing callback:", error);
    }
});
