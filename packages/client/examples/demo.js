import SimfinityClient from '../src/SimfinityClient.js';

const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'http://localhost:3000/graphql';
const client = new SimfinityClient(ENDPOINT);

const log = (label, data) => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(label);
  console.log('='.repeat(60));
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

(async () => {
  // -----------------------------------------------------------------------
  // 1. Initialization
  // -----------------------------------------------------------------------
  await client.init();
  log('1. Schema Discovery', {
    types: Object.keys(client.getTypes()).filter(t => client.getTypes()[t].kind === 'OBJECT'),
    queries: Object.keys(client.getQueries()),
    mutations: Object.keys(client.getMutations()),
  });

  // -----------------------------------------------------------------------
  // 2. find() -- auto-selected fields
  // -----------------------------------------------------------------------
  const allSeries = await client.find('serie').exec();
  log('2. find("serie") -- auto-selected scalar fields', allSeries);

  // -----------------------------------------------------------------------
  // 3. find() -- where scalar filter
  // -----------------------------------------------------------------------
  const dramas = await client.find('serie')
    .where('categories', 'EQ', 'Drama')
    .fields('id name categories')
    .exec();
  log('3. find("serie") -- where categories = Drama', dramas);

  // -----------------------------------------------------------------------
  // 4. find() -- where + joinObject
  // -----------------------------------------------------------------------
  const withDirector = await client.find('serie')
    .where('name', 'EQ', 'Breaking Bad')
    .joinObject('director', 'name country')
    .fields('id name')
    .exec();
  log('4. find("serie") -- where name = Breaking Bad + joinObject director', withDirector);

  // -----------------------------------------------------------------------
  // 5. find() -- joinCollection
  // -----------------------------------------------------------------------
  const withSeasons = await client.find('serie')
    .where('name', 'EQ', 'Breaking Bad')
    .joinCollection('seasons', 'number year state')
    .fields('id name')
    .exec();
  log('5. find("serie") -- joinCollection seasons', withSeasons);

  // -----------------------------------------------------------------------
  // 6. find() -- nested joinCollection (seasons.episodes)
  // -----------------------------------------------------------------------
  const withEpisodes = await client.find('serie')
    .where('name', 'EQ', 'Game of Thrones')
    .joinCollection('seasons', 'number year')
    .joinCollection('seasons.episodes', 'number name')
    .fields('id name')
    .page(1, 1)
    .exec();
  log('6. find("serie") -- nested joinCollection seasons.episodes (page 1, size 1)', withEpisodes);

  // -----------------------------------------------------------------------
  // 7. find() -- where collection filter (terms)
  // -----------------------------------------------------------------------
  const seriesWithPilot = await client.find('serie')
    .where('seasons', [
      { path: 'episodes.name', operator: 'EQ', value: 'Pilot' },
    ])
    .fields('id name')
    .exec();
  log('7. find("serie") -- where seasons.episodes.name = Pilot', seriesWithPilot);

  // -----------------------------------------------------------------------
  // 8. find() -- pagination + sort
  // -----------------------------------------------------------------------
  const sortedStars = await client.find('star')
    .sort('name', 'ASC')
    .page(1, 5)
    .fields('id name')
    .exec();
  log('8. find("star") -- sorted ASC, page 1 size 5', sortedStars);

  // -----------------------------------------------------------------------
  // 9. getById()
  // -----------------------------------------------------------------------
  if (allSeries.length > 0) {
    const serie = await client.getById('serie', allSeries[0].id,
      'id name categories');
    log('9. getById("serie") -- ' + allSeries[0].id, serie);
  }

  // -----------------------------------------------------------------------
  // 10. add() + update() + delete() -- full CRUD cycle
  // -----------------------------------------------------------------------
  const demoName = `Demo Actor ${Date.now()}`;
  log('10. CRUD cycle -- add / update / delete star', '--- Starting ---');

  const newStar = await client.add('star', { name: demoName }, 'id name');
  console.log('  Added:', newStar);

  const updated = await client.update('star', newStar.id,
    { name: demoName + ' Updated' }, 'id name');
  console.log('  Updated:', updated);

  const deleted = await client.delete('star', newStar.id, 'id name');
  console.log('  Deleted:', deleted);

  // -----------------------------------------------------------------------
  // 11. transition() -- state machine
  // -----------------------------------------------------------------------
  const scheduledSeasons = await client.find('season')
    .where('state', 'EQ', 'SCHEDULED')
    .fields('id number state')
    .page(1, 1)
    .exec();

  if (scheduledSeasons.length > 0) {
    const seasonId = scheduledSeasons[0].id;
    log('11. State machine -- activate then finalize season ' + seasonId, '');

    const activated = await client.transition('season', 'activate', seasonId, 'id number state');
    console.log('  Activated:', activated);

    const finalized = await client.transition('season', 'finalize', seasonId, 'id number state');
    console.log('  Finalized:', finalized);
  } else {
    log('11. State machine -- skipped (no SCHEDULED seasons)', '');
  }

  // -----------------------------------------------------------------------
  // 12. execute() -- raw GraphQL
  // -----------------------------------------------------------------------
  const raw = await client.execute('{ stars(pagination: { page: 1, size: 2 }) { id name } }');
  log('12. execute() -- raw GraphQL query', raw.data);

  // -----------------------------------------------------------------------
  // 13. Full builder example -- all features combined
  // -----------------------------------------------------------------------
  const full = await client.find('serie')
    .where('categories', 'EQ', 'Drama')
    .joinObject('director', 'name country')
    .joinCollection('seasons', 'number year state')
    .joinCollection('seasons.episodes', 'number name')
    .page(1, 2)
    .sort('name', 'ASC')
    .fields('id name categories')
    .exec();
  log('13. Full builder -- filters + joins + pagination + sort', full);

  // -----------------------------------------------------------------------
  // 14. aggregate() -- count seasons per serie
  // -----------------------------------------------------------------------
  const aggBasic = await client.aggregate('season')
    .groupBy('serie')
    .fact('COUNT', 'seasonCount', 'id')
    .exec();
  log('14. aggregate("season") -- count seasons per serie', aggBasic);

  // -----------------------------------------------------------------------
  // 15. aggregate() -- multiple facts
  // -----------------------------------------------------------------------
  const aggMulti = await client.aggregate('season')
    .groupBy('serie')
    .fact('COUNT', 'seasonCount', 'id')
    .fact('AVG', 'avgYear', 'year')
    .fact('MIN', 'minYear', 'year')
    .fact('MAX', 'maxYear', 'year')
    .exec();
  log('15. aggregate("season") -- COUNT + AVG + MIN + MAX year', aggMulti);

  // -----------------------------------------------------------------------
  // 16. aggregate() -- with pagination and sort
  // -----------------------------------------------------------------------
  const aggPaged = await client.aggregate('season')
    .groupBy('serie')
    .fact('COUNT', 'seasonCount', 'id')
    .page(1, 3)
    .sort('serie', 'ASC')
    .exec();
  log('16. aggregate("season") -- with page(1,3) + sort', aggPaged);

  // -----------------------------------------------------------------------
  // 17. aggregate() -- episodes with filter
  // -----------------------------------------------------------------------
  const aggFiltered = await client.aggregate('episode')
    .groupBy('season')
    .fact('COUNT', 'episodeCount', 'id')
    .page(1, 5)
    .exec();
  log('17. aggregate("episode") -- count episodes per season', aggFiltered);

  // -----------------------------------------------------------------------
  // 18. Scalar type utilities (Feature 2)
  // -----------------------------------------------------------------------
  log('18. Scalar type utilities', {
    'getActualScalarType("SeasonNumber_Int")': client.getActualScalarType('SeasonNumber_Int'),
    'getActualScalarType("StartDate_Date")': client.getActualScalarType('StartDate_Date'),
    'isNumericScalar("SeasonNumber_Int")': client.isNumericScalar('SeasonNumber_Int'),
    'isNumericScalar("String")': client.isNumericScalar('String'),
    'isBooleanScalar("Boolean")': client.isBooleanScalar('Boolean'),
    'isDateTimeScalar("EpisodeDate_DateTime")': client.isDateTimeScalar('EpisodeDate_DateTime'),
    'isDateTimeScalar("Int")': client.isDateTimeScalar('Int'),
  });

  // -----------------------------------------------------------------------
  // 19. Schema metadata access (Feature 3)
  // -----------------------------------------------------------------------
  const serieType = client.getTypes()['serie'] ? 'serie' : 'Serie';
  const serieFields = client.getFieldsOfType(serieType);
  log('19. Schema metadata -- getFieldsOfType(' + serieType + ')', serieFields.map(f => ({
    name: f.name,
    kind: f.type.kind,
    typeName: f.type.name,
    extensions: f.extensions,
  })));

  const objectFields = serieFields.filter(f => f.type.kind === 'OBJECT');
  if (objectFields.length > 0) {
    const objField = objectFields[0];
    log('19b. Schema metadata -- extensions for ' + serieType + '.' + objField.name, {
      extensions: client.getFieldExtensions(serieType, objField.name),
      displayField: client.getDisplayField(serieType, objField.name),
      isEmbedded: client.isEmbeddedField(serieType, objField.name),
      connectionField: client.getConnectionField(serieType, objField.name),
      isStateMachine: client.isStateMachineField(serieType, objField.name),
      isReadOnly: client.isReadOnlyField(serieType, objField.name),
    });
  }

  // -----------------------------------------------------------------------
  // 20. buildSelectionSet / autoSelect (Feature 4)
  // -----------------------------------------------------------------------
  const selSet = client.buildSelectionSet(serieType);
  log('20. buildSelectionSet(' + serieType + ')', selSet);

  const autoSelectResult = await client.find(serieType)
    .autoSelect()
    .page(1, 2)
    .exec();
  log('20b. find().autoSelect().page(1,2).exec()', autoSelectResult);

  // -----------------------------------------------------------------------
  // 21. Entity & query name resolution (Feature 5)
  // -----------------------------------------------------------------------
  log('21. Entity & query name resolution', {
    listEntityNames: client.getListEntityNames(),
    'getQueryNamesForType(serieType)': client.getQueryNamesForType(serieType),
    'getPluralQueryName(serieType)': client.getPluralQueryName(serieType),
    'getSingularQueryName(serieType)': client.getSingularQueryName(serieType),
  });

  const pluralName = client.getPluralQueryName(serieType);
  if (pluralName) {
    log('21b. getTypeNameForQuery("' + pluralName + '")',
      client.getTypeNameForQuery(pluralName));
  }

  // -----------------------------------------------------------------------
  // 22. transformInput (Feature 6)
  // -----------------------------------------------------------------------
  const rawInput = {
    name: 'Test Serie',
    categories: 'Drama',
    year: '2025',
    __typename: 'Serie',
    director: { id: 'dir-123', name: 'Some Director', __typename: 'Director' },
  };
  const transformed = client.transformInput(serieType, rawInput, { mode: 'create' });
  log('22. transformInput -- raw vs transformed', { rawInput, transformed });

  // -----------------------------------------------------------------------
  // 23. transformCollectionDelta (Feature 7)
  // -----------------------------------------------------------------------
  const seasonType = client.getTypes()['season'] ? 'season' : 'Season';
  const delta = {
    added: [
      { id: 'temp_1', number: '3', year: '2025', __typename: 'Season', __status: 'added' },
    ],
    updated: [
      { id: 'real-id-1', number: '2', year: '2024', __status: 'modified' },
    ],
    deleted: [
      { id: 'del-id-1' },
    ],
  };
  const connectionField = client.getConnectionField(serieType, 'seasons');
  const transformedDelta = client.transformCollectionDelta(seasonType, delta, {
    connectionField: connectionField || 'serie',
  });
  log('23. transformCollectionDelta', { delta, transformedDelta });

  // -----------------------------------------------------------------------
  // 24. findByParent (Feature 8)
  // -----------------------------------------------------------------------
  if (allSeries.length > 0) {
    const parentId = allSeries[0].id;
    const childSeasons = await client
      .findByParent(seasonType, 'serie', parentId)
      .page(1, 5, true)
      .fields('id number year')
      .exec();
    log('24. findByParent(' + seasonType + ', "serie", "' + parentId + '")', childSeasons);
  } else {
    log('24. findByParent -- skipped (no series)', '');
  }

  // -----------------------------------------------------------------------
  // 25. search (Feature 9)
  // -----------------------------------------------------------------------
  const searchResults = await client.search('star', 'a', {
    displayField: 'name',
    page: 1,
    size: 5,
  });
  log('25. search("star", "a", { displayField: "name" })', searchResults);

  // -----------------------------------------------------------------------
  // 26. State machine metadata (Feature 10)
  // -----------------------------------------------------------------------
  log('26. State machine metadata', {
    'getStateMachineFields(seasonType)': client.getStateMachineFields(seasonType),
    'getAvailableTransitions(seasonType)': client.getAvailableTransitions(seasonType),
  });

  // -----------------------------------------------------------------------
  // 27. execWithMeta -- pagination count (Feature 11)
  // -----------------------------------------------------------------------
  const { data: pagedSeries, extensions } = await client
    .find(serieType)
    .page(1, 2, true)
    .execWithMeta();
  log('27. execWithMeta -- pagination count', {
    data: pagedSeries,
    extensions,
    totalCount: extensions?.count,
  });

  // -----------------------------------------------------------------------
  // 28. find() with OR filter
  // -----------------------------------------------------------------------
  const orResults = await client.find(serieType)
    .or([
      SimfinityClient.condition('categories', 'EQ', 'Drama'),
      SimfinityClient.condition('categories', 'EQ', 'Comedy'),
    ])
    .fields('id name categories')
    .exec();
  log('28. find() -- OR filter (Drama OR Comedy)', orResults);

  // -----------------------------------------------------------------------
  // 29. find() with flat where + OR combined
  // -----------------------------------------------------------------------
  const combinedOrResults = await client.find(serieType)
    .where('categories', 'NE', 'Horror')
    .or([
      SimfinityClient.condition('name', 'LIKE', 'Breaking'),
      SimfinityClient.condition('name', 'LIKE', 'Game'),
    ])
    .fields('id name categories')
    .exec();
  log('29. find() -- flat where + OR (not Horror AND (name LIKE Breaking OR Game))', combinedOrResults);

  // -----------------------------------------------------------------------
  // 30. find() with AND containing nested OR
  // -----------------------------------------------------------------------
  const nestedAndOrResults = await client.find(serieType)
    .and([
      { OR: [
        SimfinityClient.condition('categories', 'EQ', 'Drama'),
        SimfinityClient.condition('categories', 'EQ', 'Comedy'),
      ]},
    ])
    .fields('id name categories')
    .exec();
  log('30. find() -- AND with nested OR groups', nestedAndOrResults);

  // -----------------------------------------------------------------------
  // 31. aggregate() with OR filter
  // -----------------------------------------------------------------------
  const aggOrResults = await client.aggregate(seasonType)
    .groupBy('serie')
    .fact('COUNT', 'seasonCount', 'id')
    .or([
      SimfinityClient.condition('year', 'GTE', 2020),
      SimfinityClient.condition('year', 'LTE', 2010),
    ])
    .exec();
  log('31. aggregate() -- OR filter (year >= 2020 OR year <= 2010)', aggOrResults);

  console.log('\n' + '='.repeat(60));
  console.log('Demo complete.');
  console.log('='.repeat(60));
})();
