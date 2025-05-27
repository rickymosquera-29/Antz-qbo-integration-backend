require('dotenv').config();
const express = require('express');
const IntuitOAuth = require('intuit-oauth');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('QBO Integration API Running');
});

// Initialize OAuth client
const oauthClient = new IntuitOAuth({
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  environment: process.env.QB_ENVIRONMENT, // 'sandbox' or 'production'
  redirectUri: process.env.QB_REDIRECT_URI
});

// Step 1: Redirect user to QuickBooks for authorization
app.get('/authUri', (req, res) => {
  const authUri = oauthClient.authorizeUri({
    scope: [IntuitOAuth.scopes.Accounting],
    state: 'testState'
  });
  res.redirect(authUri);
});

// Step 2: Handle the OAuth2 callback and show popup success (NO redirect to dashboard)
app.get('/callback', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>QuickBooks Connected Successfully!</h1>
        <p>You can close this window and return to the dashboard.</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({
              type: 'qbo_connected',
              code: '${req.query.code || ''}',
              realmId: '${req.query.realmId || ''}'
            }, '*');
          }
          setTimeout(() => window.close(), 3000);
        </script>
      </body>
    </html>
  `);
});

// Test endpoint to create a customer in QBO
app.post('/create-customer', async (req, res) => {
  try {
    const { access_token, realmId } = req.body; // You can hardcode these for now if needed

    const customerPayload = {
      DisplayName: "Test Customer " + Date.now(),
      PrimaryEmailAddr: { Address: "test@example.com" }
    };

    const response = await axios.post(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/9341454666511557/customer`,
      customerPayload,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});



// Test endpoint to create an invoice in QBO
app.post('/create-invoice', async (req, res) => {
  try {
    const { access_token, realmId } = req.body;

    const customerId = "59";
    const itemId = "21";

    const invoicePayload = {
      CustomerRef: { value: customerId },
      Line: [
        {
          Amount: 100,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            ItemRef: { value: itemId },
            Qty: 1,
            UnitPrice: 100,
            TaxCodeRef: { value: "TAX" }
          }
        }
      ]
    };
    
    console.log("QBO Access Token (before API call):", access_token);
    const response = await axios.post(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/9341454666511557/invoice`,
      invoicePayload,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error('QBO Error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Real integration endpoint for syncing policy data as an invoice
app.post('/sync-policy-invoice', async (req, res) => {
  try {
    let { qboAuthCode, invoice, realmId } = req.body;
    if (!invoice || !Array.isArray(invoice.coverages) || !Array.isArray(invoice.charges)) {
      return res.status(400).json({ error: "Invalid invoice data. 'coverages' and 'charges' arrays are required." });
    }

    // Exchange auth code for access token
    const oauthClientLocal = new IntuitOAuth({
      clientId: process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      environment: process.env.QB_ENVIRONMENT,
      redirectUri: process.env.QB_REDIRECT_URI
    });

    const tokenResponse = await oauthClientLocal.createToken(`?code=${qboAuthCode}&state=testState`);
    const access_token = tokenResponse.getJson().access_token;
    console.log("QBO Access Token:", access_token);
    // Use realmId from the request body

    // 1. Map coverages and charges to QBO invoice line items
    const lineItems = [];

    // Add coverages as line items
    invoice.coverages.forEach(cov => {
      lineItems.push({
        Amount: cov.premium,
        DetailType: "SalesItemLineDetail",
        Description: cov.type,
        SalesItemLineDetail: {
          ItemRef: { value: "21" }, // Use a real item ID in production
          Qty: 1,
          UnitPrice: cov.premium,
          TaxCodeRef: { value: "TAX" }
        }
      });
    });

    // Add charges as line items
    invoice.charges.forEach(charge => {
      lineItems.push({
        Amount: charge.amount,
        DetailType: "SalesItemLineDetail",
        Description: charge.type,
        SalesItemLineDetail: {
          ItemRef: { value: "21" }, // Use a real item ID in production
          Qty: 1,
          UnitPrice: charge.amount,
          TaxCodeRef: { value: "TAX" }
        }
      });
    });

    // --- CUSTOMER LOGIC START ---
    const customerName = invoice.assured || 'Unknown Customer';
    let customerId = null;
    // Search for customer in QBO
    const query = `select * from Customer where DisplayName = '${customerName.replace(/'/g, "\\'")}'`;
    const customerQueryResp = await axios.get(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/text',
          Accept: 'application/json'
        }
      }
    );
    if (customerQueryResp.data.QueryResponse.Customer && customerQueryResp.data.QueryResponse.Customer.length > 0) {
      // Customer exists
      customerId = customerQueryResp.data.QueryResponse.Customer[0].Id;
    } else {
      // Customer does not exist, create it
      const createCustomerResp = await axios.post(
        `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/customer`,
        { DisplayName: customerName },
        {
          headers: {
            Authorization: `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        }
      );
      customerId = createCustomerResp.data.Customer.Id;
    }
    // --- CUSTOMER LOGIC END ---

    // 2. Build the invoice payload
    const invoicePayload = {
      CustomerRef: { value: customerId },
      Line: lineItems,
      TxnDate: invoice.dateIssued || undefined,
      PrivateNote: `PDF: ${req.body.fileName || ''} | QUOTE ID: ${invoice.quoteId || ''} | POL NO: ${invoice.policyNumber || ''} | ASSURED: ${invoice.assured || ''} | ADDRESS: ${invoice.address || ''} | DATE_ISSUED: ${invoice.dateIssued || ''} | INCEP_DATE: ${invoice.incepDate || ''} | AGENCY: ${invoice.agency || ''} | AGENT: ${invoice.agent || ''} | PREPARED BY: ${invoice.preparedBy || ''}`
    };

    // 3. Send the invoice to QBO
    const response = await axios.post(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/invoice`,
      invoicePayload,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    // Return invoice data + customer info for frontend to store
    res.json({
      ...response.data,
      customerName: customerName,
      customerId: customerId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});