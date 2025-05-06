import { app } from '@azure/functions';
import './functions/QueryChatbot.js';

app.setup({
    enableHttpStream: true,
});
