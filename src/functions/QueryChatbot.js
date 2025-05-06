import { app } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import axios from "axios";

app.http('QueryChatbot', {
  authLevel: 'anonymous',
  methods: ['GET', 'POST'],
  handler: async (request, context) => {
    try {
      context.log("QueryChatbot function triggered");
      
      // Parse request and extract the question
      let questionText;
      try {
        const requestData = await request.json();
        questionText = requestData.question || "Tell me about your portfolio";
        context.log(`Processing question: "${questionText}"`);
      } catch (parseError) {
        context.log.error(`Error parsing request: ${parseError.message}`);
        return { status: 400, body: JSON.stringify({ error: "Invalid request format" }) };
      }

      // Authentication with environment-aware credentials
      context.log("Setting up authentication strategy...");
      let accessToken;

      // Check if running locally
      const isLocalDevelopment = !process.env.WEBSITE_INSTANCE_ID; // Azure-specific env variable

      if (isLocalDevelopment) {
        // LOCAL DEV: Use API key authentication (faster, more reliable for local dev)
        context.log("Local development detected, using API key authentication");
        accessToken = process.env.LANGUAGE_SERVICE_KEY;
        if (!accessToken) {
          throw new Error("LANGUAGE_SERVICE_KEY environment variable is required for local development");
        }
      } else {
        // AZURE: Use managed identity with timeout protection
        context.log("Azure environment detected, using managed identity");
        try {
          const credential = new DefaultAzureCredential({
            managedIdentityClientId: process.env.MANAGED_IDENTITY_CLIENT_ID
          });
          
          // Create a promise with timeout
          const tokenPromise = credential.getToken("https://cognitiveservices.azure.com/.default");
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Token acquisition timed out")), 10000)
          );
          
          // Race the promises
          const tokenResponse = await Promise.race([tokenPromise, timeoutPromise]);
          accessToken = tokenResponse.token;
          context.log("Token acquired successfully");
        } catch (authError) {
          context.log.error(`Authentication error: ${authError.message}`);
          throw new Error(`Failed to authenticate: ${authError.message}`);
        }
      }
      
      // Prepare and make API request
      const endpoint = process.env.LANGUAGE_SERVICE_ENDPOINT;
      if (!endpoint) {
        throw new Error("LANGUAGE_SERVICE_ENDPOINT environment variable is not defined");
      }
      
      const projectName = process.env.QA_KNOWLEDGE_BASE_ID;
      if (!projectName) {
        throw new Error("QA_KNOWLEDGE_BASE_ID environment variable is not defined");
      }
      
      const qnaUrl = `${endpoint}/language/:query-knowledgebases?projectName=${projectName}&deploymentName=production&api-version=2023-04-01`;
      const qnaQuery = { 
        question: questionText, 
        top: 1 
      };
      
      context.log(`Sending request to: ${qnaUrl}`);

      const headers = {
        'Content-Type': 'application/json'
      };
      
      // Add appropriate auth header based on authentication type
      if (isLocalDevelopment) {
        headers['Ocp-Apim-Subscription-Key'] = accessToken;
      } else {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
      
      try {
        // Azure best practice: Add timeout and retry configuration
        const response = await axios({
          method: 'post',
          url: qnaUrl,
          data: qnaQuery,  // Axios automatically serializes to JSON
          headers: headers,
          timeout: 15000,  // 15 second timeout per Azure best practices
          maxRetries: 3,   // Retry failed requests
          retryDelay: 1000 // Delay between retries (ms)
        });
        
        // Successful response
        context.log("Successfully retrieved answer from knowledge base");
        
        // Return the result - axios automatically parses JSON
        return {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(response.data)
        };
      } catch (axiosError) {
        // Axios consolidates errors - check for specific conditions
        const status = axiosError.response?.status || 500;
        const errorMessage = axiosError.response?.data || axiosError.message;
        
        context.log.error(`API error: ${status} - ${JSON.stringify(errorMessage)}`);
        
        // Enhanced error reporting for different error types based on Azure best practices
        if (axiosError.code === 'ECONNABORTED') {
          return {
            status: 504, // Gateway Timeout
            body: JSON.stringify({ error: "Request to Language service timed out" })
          };
        } else if (axiosError.response) {
          // The server responded with a status code outside of 2xx range
          return {
            status: status,
            body: JSON.stringify({ 
              error: `Language service error: ${status}`,
              details: errorMessage
            })
          };
        } else {
          // Network error or request setup error
          return {
            status: 500,
            body: JSON.stringify({ error: "Failed to connect to Language service" })
          };
        }
      }
    } catch (error) {
      // Comprehensive error handling
      context.log.error(`Function error: ${error.message}`);
      context.log.error(error.stack);
      return {
        status: 500,
        body: JSON.stringify({ 
          error: "An error occurred processing your request",
          details: error.message
        })
      };
    }
  }
});