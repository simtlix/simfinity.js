import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';

const isAdmin = (context) => context?.user?.role === 'ADMIN';
const tenantOf = (context) => context?.user?.tenant ?? '__none__';
const scopeFor = (scope) => ({ find: scope, get_by_id: scope, aggregate: scope });

/**
 * Posts reference scoped users, and users reference scoped teams. User scopes add a flat filter on
 * a field clients may not query; team scopes add an OR group. `passwordHash` is masked by an
 * application resolver, and `nickname` opts back in with `queryable: true`.
 */
export const createQueryPathFixture = (runtime, prefix = 'Qpa') => {
  const userScope = async ({ args, context }) => {
    if (isAdmin(context)) return;
    args.tenant = { operator: 'EQ', value: tenantOf(context) };
  };
  const teamScope = async ({ args, context }) => {
    if (isAdmin(context)) return;
    args.AND = [...(args.AND || []), {
      OR: [
        { conditions: [{ field: 'tenant', operator: 'EQ', value: tenantOf(context) }] },
        { conditions: [{ field: 'name', operator: 'EQ', value: 'Public' }] },
      ],
    }];
  };

  const Team = new GraphQLObjectType({
    name: `${prefix}Team`,
    extensions: { scope: scopeFor(teamScope) },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      tenant: { type: GraphQLString },
      members: { type: new GraphQLList(User), extensions: { relation: { connectionField: 'team' } } },
    }),
  });
  const User = new GraphQLObjectType({
    name: `${prefix}User`,
    extensions: { scope: scopeFor(userScope) },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      email: { type: GraphQLString },
      bio: { type: GraphQLString },
      tenant: { type: GraphQLString, extensions: { queryable: false } },
      passwordHash: { type: GraphQLString, resolve: () => null },
      nickname: {
        type: GraphQLString,
        extensions: { queryable: true },
        resolve: (user) => user.nickname,
      },
      team: { type: Team, extensions: { relation: { connectionField: 'team' } } },
    }),
  });
  const Post = new GraphQLObjectType({
    name: `${prefix}Post`,
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      author: { type: User, extensions: { relation: { connectionField: 'author' } } },
    }),
  });

  const lower = prefix.toLowerCase();
  const names = {
    team: `${lower}team`,
    teams: `${lower}teams`,
    user: `${lower}user`,
    users: `${lower}users`,
    post: `${lower}post`,
    posts: `${lower}posts`,
  };
  runtime.connect(null, Team, names.team, names.teams);
  runtime.connect(null, User, names.user, names.users);
  runtime.connect(null, Post, names.post, names.posts);
  return { Team, User, Post, names };
};

/**
 * Notes reference members whose find scope filters through their memberships collection, the
 * membership-based tenancy form. Joins through that collection repeat a note once per matching
 * membership, so joined scopes of this kind are rejected.
 */
export const createMembershipScopeFixture = (runtime, prefix = 'Qpm') => {
  const memberScope = async ({ args, context }) => {
    if (isAdmin(context)) return;
    args.memberships = { terms: [{ path: 'org', operator: 'EQ', value: tenantOf(context) }] };
  };

  const Membership = new GraphQLObjectType({
    name: `${prefix}Membership`,
    fields: () => ({
      id: { type: GraphQLID },
      org: { type: GraphQLString },
      member: { type: Member, extensions: { relation: { connectionField: 'member' } } },
    }),
  });
  const Member = new GraphQLObjectType({
    name: `${prefix}Member`,
    extensions: { scope: scopeFor(memberScope) },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      memberships: { type: new GraphQLList(Membership), extensions: { relation: { connectionField: 'member' } } },
    }),
  });
  const Note = new GraphQLObjectType({
    name: `${prefix}Note`,
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      member: { type: Member, extensions: { relation: { connectionField: 'member' } } },
    }),
  });

  const lower = prefix.toLowerCase();
  const names = {
    member: `${lower}member`,
    members: `${lower}members`,
    membership: `${lower}membership`,
    memberships: `${lower}memberships`,
    note: `${lower}note`,
    notes: `${lower}notes`,
  };
  runtime.connect(null, Membership, names.membership, names.memberships);
  runtime.connect(null, Member, names.member, names.members);
  runtime.connect(null, Note, names.note, names.notes);
  return {
    Membership, Member, Note, names,
  };
};

/**
 * Tasks reference staff whose find scope filters an embedded list of roles: by the referenced
 * organization (`roles.org.id`), which joins once per role, or by a scalar role field
 * (`roles.level`) when `context.user.form` is `'level'`.
 */
export const createEmbeddedRoleScopeFixture = (runtime, prefix = 'Qpe') => {
  const staffScope = async ({ args, context }) => {
    if (isAdmin(context)) return;
    args.roles = context.user?.form === 'level'
      ? { terms: [{ path: 'level', operator: 'EQ', value: 'lead' }] }
      : { terms: [{ path: 'org.id', operator: 'IN', value: context.user?.orgs ?? [] }] };
  };

  const Org = new GraphQLObjectType({
    name: `${prefix}Org`,
    fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString } }),
  });
  const Role = new GraphQLObjectType({
    name: `${prefix}Role`,
    fields: () => ({
      level: { type: GraphQLString },
      org: { type: Org, extensions: { relation: { connectionField: 'org' } } },
    }),
  });
  const Staff = new GraphQLObjectType({
    name: `${prefix}Staff`,
    extensions: { scope: scopeFor(staffScope) },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      roles: { type: new GraphQLList(Role), extensions: { relation: { embedded: true } } },
    }),
  });
  const Task = new GraphQLObjectType({
    name: `${prefix}Task`,
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      staff: { type: Staff, extensions: { relation: { connectionField: 'staff' } } },
    }),
  });

  const lower = prefix.toLowerCase();
  const names = {
    org: `${lower}org`,
    orgs: `${lower}orgs`,
    staff: `${lower}staff`,
    staffs: `${lower}staffs`,
    task: `${lower}task`,
    tasks: `${lower}tasks`,
  };
  runtime.connect(null, Org, names.org, names.orgs);
  runtime.addNoEndpointType(Role);
  runtime.connect(null, Staff, names.staff, names.staffs);
  runtime.connect(null, Task, names.task, names.tasks);
  return {
    Org, Role, Staff, Task, names,
  };
};
