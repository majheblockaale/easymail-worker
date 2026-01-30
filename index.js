export class EmailQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = [];
    this.processing = false;
  }

  async fetch(request) {
    if (request.method === 'POST') {
      const email = await request.json();
      await this.addEmail(email);
      return new Response('Queued', { status: 202 });
    }
    return new Response('Not found', { status: 404 });
  }

  async addEmail(email) {
    this.queue.push(email);
    if (this.queue.length >= 50) {
      await this.processBatch();
    }
  }

  async processBatch() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const batch = this.queue.splice(0, 100);

    try {
      const promises = batch.map(email => this.sendWithRetry(email, 0));
      await Promise.allSettled(promises);
    } finally {
      this.processing = false;
      if (this.queue.length > 0) await this.processBatch();
    }
  }

  async sendWithRetry(email, attempt) {
    const maxRetries = 3;
    const baseDelay = 1000;
    
    try {
      const response = await fetch(this.env.BASE44_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Cloudflare-Email-Worker/1.0'
        },
        body: JSON.stringify(email)
      });

      if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
      return { success: true };
    } catch (error) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
        return this.sendWithRetry(email, attempt + 1);
      }
      throw error;
    }
  }
}

export default {
  async email(message, env, ctx) {
    try {
      const from = message.from;
      const to = message.to;
      const subject = message.headers.get('subject') || '(No subject)';
      
      const [textResult, htmlResult] = await Promise.allSettled([
        message.text().catch(() => ''),
        message.html().catch(() => '')
      ]);

      const text = textResult.status === 'fulfilled' ? textResult.value : '';
      const html = htmlResult.status === 'fulfilled' ? htmlResult.value : '';
      const emailData = { from, to, subject, text, html };

      const id = env.QUEUE.idFromName('global-email-queue');
      const queue = env.QUEUE.get(id);

      ctx.waitUntil(
        queue.fetch(new Request('http://localhost/queue', {
          method: 'POST',
          body: JSON.stringify(emailData)
        }))
      );

      return new Response('Accepted', { status: 202 });
    } catch (error) {
      return new Response('Error: ' + error.message, { status: 500 });
    }
  }
};
