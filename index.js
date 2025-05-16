require('dotenv').config();
const express = require('express');
const IntuitOAuth = require('intuit-oauth');
const axios = require('axios');
const app = express();

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

// Step 2: Handle the OAuth2 callback and redirect to dashboard
app.get('/callback', async (req, res) => {
  try {
    const parseRedirect = await oauthClient.createToken(req.url);
    // Optionally, you can store tokens here if needed
    res.redirect('https://webapp-database-97dfe.web.app/Dashboard.html');
  } catch (e) {
    res.status(500).send('OAuth callback error: ' + e.message);
  }
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
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/customer`,
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

    // Minimal invoice payload for testing
    const invoicePayload = {
      CustomerRef: { value: "1" }, // Use a real customer ID if available
      Line: [
        {
          Amount: 100,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            ItemRef: { value: "1" }, // Use a real item ID if available
            Qty: 1,
            UnitPrice: 100
          }
        }
      ]
    };

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

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Real integration endpoint for syncing policy data as an invoice
app.post('/sync-policy-invoice', async (req, res) => {
  try {
    const { access_token, realmId, customer, invoice } = req.body;

    // 1. Create or find the customer in QBO (for now, use a default customer ID "1" for testing)
    // In production, you would search for the customer or create them if they don't exist.

    // 2. Map coverages and charges to QBO invoice line items
    const lineItems = [];

    // Add coverages as line items
    invoice.coverages.forEach(cov => {
      lineItems.push({
        Amount: cov.premium,
        DetailType: "SalesItemLineDetail",
        Description: cov.type,
        SalesItemLineDetail: {
          ItemRef: { value: "1" }, // Use a real item ID in production
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
          ItemRef: { value: "1" }, // Use a real item ID in production
          Qty: 1,
          UnitPrice: charge.amount,
          TaxCodeRef: { value: "TAX" }
        }
      });
    });

    // 3. Build the invoice payload
    const invoicePayload = {
      CustomerRef: { value: "1" }, // Use a real customer ID in production
      Line: lineItems,
      TxnDate: invoice.dateIssued,
      DueDate: invoice.expiryDate,
      PrivateNote: `Policy No: ${invoice.policyNumber}, Quote ID: ${invoice.quoteId}, Agent: ${invoice.agent}`,
      // You can add more fields as needed
    };

    // 4. Send the invoice to QBO
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

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});