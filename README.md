# TNT Corporate Lead Automation System - Backend API

A production-grade lead management and automation system designed to achieve TNT Limousine's business goals of sub-5-minute response times and $15K+ monthly revenue recovery.

## 🎯 Business Objectives

- **Response Time**: Reduce lead response from 48-72 hours to <5 minutes
- **Revenue Recovery**: Target $15K+ monthly through improved conversion rates
- **Automation**: 24/7 lead capture with intelligent scoring and routing
- **Integration**: Seamless sync with FastTrack InVision, Zoho CRM, and richweb.net SMTP

## 🏗️ Architecture Overview

```
TNT Lead System Architecture:
├── API Layer (Express.js + JWT Auth)
├── Business Logic (Sequelize Models + Custom Logic)
├── Queue System (Bull + Redis)
├── External Integrations (Zoho, FastTrack, SMTP)
├── Database (PostgreSQL + Full-text Search)
└── Monitoring (Winston + Health Checks)
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 13+
- Redis 6+
- SMTP credentials (richweb.net)

### Environment Configuration

Create `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Configure required variables:

```env
# Database
DATABASE_URL=postgresql://username:password@localhost:5432/tnt_lead_system
DB_HOST=localhost
DB_PORT=5432
DB_NAME=tnt_lead_system
DB_USER=postgres
DB_PASSWORD=your_password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# SMTP (richweb.net)
SMTP_HOST=mail.richweb.net
SMTP_PORT=587
SMTP_USER=dispatch@tntlimousine.com
SMTP_PASS=your_smtp_password
SMTP_FROM=dispatch@tntlimousine.com

# Authentication
JWT_SECRET=your-super-secure-jwt-secret-here
TNT_API_KEY=your-api-key-for-external-access

# Integrations
ZOHO_ACCESS_TOKEN=your_zoho_token
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
SMS_FROM_NUMBER=+15551234567

# Application
NODE_ENV=development
PORT=3001
API_VERSION=v2
DASHBOARD_URL=http://localhost:3000
```

### Installation & Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Setup database:**
```bash
# Create database
createdb tnt_lead_system

# Run schema migration
psql -d tnt_lead_system -f ../phase2-architecture/database-schema.sql
```

3. **Initialize default data:**
```bash
npm run db:seed
```

4. **Start development server:**
```bash
npm run dev
```

### Verification

Check system health:
```bash
curl http://localhost:3001/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "TNT Corporate Lead Automation System",
  "business_goal": "Sub-5-minute lead response time",
  "revenue_target": "$15K+ monthly recovery"
}
```

## 📊 API Documentation

### Core Endpoints

#### Lead Management
- `POST /api/v2/leads` - Create lead (auto-triggers 5-min response)
- `GET /api/v2/leads` - List leads with filtering
- `PUT /api/v2/leads/{id}` - Update lead status
- `GET /api/v2/leads/high-priority` - Get urgent leads

#### Automation
- `GET /api/v2/automation/templates` - Email templates
- `POST /api/v2/automation/trigger` - Manual automation trigger
- `GET /api/v2/automation/performance` - Email metrics

#### Analytics
- `GET /api/v2/analytics/dashboard` - Main KPI dashboard
- `GET /api/v2/analytics/conversion-funnel` - Conversion analysis
- `GET /api/v2/analytics/response-times` - Response time metrics

#### Webhooks
- `POST /api/v2/webhooks/form-submission` - Website form capture
- `POST /api/v2/webhooks/email-engagement` - Email tracking
- `POST /api/v2/webhooks/crm-updates` - CRM sync events

### Authentication

All protected endpoints require authentication:

```bash
# Using API Key
curl -H "X-API-Key: your-api-key" http://localhost:3001/api/v2/leads

# Using JWT Token
curl -H "Authorization: Bearer your-jwt-token" http://localhost:3001/api/v2/leads
```

## 🔄 Background Processing

The system uses Bull queues for background processing:

### Queue Types

1. **Email Queue** (Highest Priority)
   - Instant responses (<30 seconds)
   - Follow-up sequences
   - Template processing

2. **Notification Queue**
   - High-value lead alerts
   - Response time violations
   - Slack notifications

3. **Integration Queue**
   - Zoho CRM sync
   - FastTrack InVision sync
   - Webhook replay

4. **Analytics Queue**
   - Daily metrics calculation
   - Performance analysis

### Monitoring Queues

```bash
# Check queue status
curl http://localhost:3001/api/v2/automation/queue-status
```

## 🏢 Business Logic

### Lead Scoring Algorithm

Automatic scoring based on:
- **Company Information** (10 points): Business vs individual
- **Service Value** (30 points): Estimated booking value
- **Service Type** (25 points): Corporate > Airport > Events > Wedding > Hourly
- **Geographic Proximity** (15 points): Distance from Richmond, VA
- **Group Size** (15 points): Larger groups = higher value
- **Timing** (5 points): Urgency factor

### Response Time Commitment

TNT's 5-minute response guarantee is enforced through:
1. Instant email queue processing (<30 seconds)
2. Manager alerts for high-value leads
3. Escalation alerts at 5+ minutes
4. Performance tracking and reporting

### Email Automation Sequences

#### Standard Follow-up (Days: 0, 3, 7, 14)
- Instant response
- 3-day check-in
- 7-day proposal
- 14-day final offer

#### High-Value Follow-up (Hours: 0, 2, 24, 72)
- Instant response
- 2-hour personal follow-up
- 24-hour manager outreach
- 72-hour final attempt

## 🔗 External Integrations

### Zoho CRM Integration
- Bidirectional lead sync
- Status updates
- Deal tracking

### FastTrack InVision
- Customer data exchange
- Service scheduling sync

### richweb.net SMTP
- Transactional emails
- Delivery tracking
- Bounce handling

### Slack Notifications
- High-value lead alerts
- Response time warnings
- Daily performance summaries

## 📈 Performance Monitoring

### Health Checks

- `/health` - Basic health
- `/health/detailed` - Full system status
- `/health/business` - Business metrics
- `/health/ready` - Deployment readiness

### Key Metrics Tracked

1. **Response Time Performance**
   - Average response time
   - % under 5 minutes
   - SLA compliance

2. **Conversion Metrics**
   - Lead-to-customer conversion
   - Revenue attribution
   - Service type performance

3. **System Performance**
   - Queue processing times
   - Integration health
   - Error rates

## 🚀 Deployment

### Production Environment

1. **Environment Variables:**
```env
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@prod-db:5432/tnt_lead_system
REDIS_URL=redis://prod-redis:6379
SMTP_HOST=mail.richweb.net
```

2. **Database Migration:**
```bash
npm run db:migrate
```

3. **Process Management:**
```bash
# Using PM2
pm2 start src/server.js --name "tnt-lead-api"
pm2 startup
pm2 save
```

4. **Nginx Configuration:**
```nginx
server {
    listen 80;
    server_name api.tntleads.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Docker Deployment

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

### Railway Deployment

```bash
# Install Railway CLI
npm install -g @railway/cli

# Deploy
railway login
railway link
railway up
```

## 🔧 Development

### Running Tests

```bash
npm test
```

### Code Quality

```bash
npm run lint
npm run lint:fix
```

### Database Operations

```bash
# Create migration
npm run db:migrate

# Seed development data
npm run db:seed
```

## 📊 Business Intelligence

### TNT Performance Dashboard

Key metrics visible in real-time:
- Lead response times
- Conversion rates by service type
- Revenue pipeline
- Geographic performance
- Peak hours analysis

### Automated Alerts

System automatically alerts on:
- Response time violations (>5 minutes)
- High-value leads (>$1,000)
- System integration failures
- Performance degradation

## 🛡️ Security

- JWT-based authentication
- API key validation for webhooks
- Rate limiting (100 requests/15 min)
- Request validation with Joi
- SQL injection prevention
- Encrypted sensitive data storage

## 📞 Support & Monitoring

### Log Levels
- `ERROR`: System failures requiring immediate attention
- `WARN`: Performance issues or failed external calls
- `INFO`: Business events and successful operations
- `DEBUG`: Detailed execution flow (development only)

### Error Handling
All errors include:
- Unique request ID for tracking
- Timestamp and error context
- Business-friendly error messages
- Integration-specific error codes

## 📈 Performance Targets

### Response Time SLA
- **Email automation**: <30 seconds
- **Lead creation**: <5 minutes end-to-end
- **API response**: <500ms average
- **Queue processing**: <2 minutes backlog

### Business Metrics
- **Lead response**: 95% under 5 minutes
- **Conversion rate**: 25%+ inquiry-to-booking
- **Revenue recovery**: $15K+ monthly
- **System uptime**: 99.9%

## 🤝 Contributing

1. Follow existing code patterns
2. Add tests for new features
3. Update documentation
4. Use conventional commit messages
5. Ensure business logic alignment

## 📄 License

Proprietary - TNT Limousine Service
Contact: admin@tntlimousine.com

---

**Built for TNT Limousine - "Driven by Service, Defined by Excellence"**

*This system is designed to support TNT's mission of providing exceptional corporate transportation while maintaining operational efficiency and business growth.*