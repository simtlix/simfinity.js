// Load in dependency order:
// 1. Embedded types with only scalar fields
import './businessHourSlot.js';
import './address.js';
import './contactInfo.js';

// 2. Base endpoint types (their lazy fields() are NOT evaluated at import)
import './user.js';
import './barbershop.js';
import './serviceCategory.js';
import './service.js';

// 3. Embedded types that reference base types via simfinity.getType()
//    (addNoEndpointType calls getFields() eagerly, so referenced types must already be registered)
import './bundleItem.js';
import './professionalService.js';

// 4. Endpoint types that use the embedded types above
import './bundle.js';
import './professional.js';

// 5. bookingLine references 'service' and 'bundle' — both must be registered first
import './bookingLine.js';
import './booking.js';

// 6. Remaining endpoint types
import './review.js';
import './favorite.js';
import './notification.js';
import './notificationPreference.js';
import './auth/registerMutations.js';
import './customMutations.js';
