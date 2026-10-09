import { describeUseDbAudit } from '../helpers/mongodb-usedb-audit.js';

// The audit model is compiled on a useDb() connection of the default connection.
describeUseDbAudit('useDb connections', ['audit']);
