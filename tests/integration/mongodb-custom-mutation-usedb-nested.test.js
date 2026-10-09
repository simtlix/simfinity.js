import { describeUseDbAudit } from '../helpers/mongodb-usedb-audit.js';

// The audit model is compiled on mongoose.connection.useDb(tenant).useDb(audit), which Mongoose
// lists in the tenant connection's otherDbs only. A file of its own: the test opens the default
// connection.
describeUseDbAudit('nested useDb connections', ['tenant', 'audit']);
