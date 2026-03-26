// netlify/functions/garmin-workout.js
// Creates a structured workout on Garmin Connect.
// Input: { accessToken, workoutName, blocs: [{reps, dist, pct, recup, durSec}] }
// Output: { workoutId, workoutName } or { error }

import fetch from 'node-fetch';

const CORS = {
  'Access-Control-Allow-Origin': 'https://vma-speed.netlify.app',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let accessToken, workoutName, blocs;
  try {
    ({ accessToken, workoutName, blocs } = JSON.parse(event.body));
    if (!accessToken || !workoutName || !Array.isArray(blocs) || blocs.length === 0) {
      throw new Error('missing');
    }
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Corps invalide' }) };
  }

  // Build Garmin workout JSON
  let groupOrder = 0;   // top-level RepeatGroupDTO stepOrder (1-based)
  let childStepId = 0;  // global leaf counter across all ExecutableStepDTOs (1-based)

  const workoutSteps = blocs.map(bloc => {
    groupOrder++;
    let stepInGroup = 0; // resets per group

    const innerSteps = [];

    // Active interval step
    stepInGroup++;
    childStepId++;
    innerSteps.push({
      type: 'ExecutableStepDTO',
      stepOrder: stepInGroup,
      childStepId,
      stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
      endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
      endConditionValue: bloc.durSec,
      targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
    });

    // Recovery step (only if recup > 0)
    if (bloc.recup > 0) {
      stepInGroup++;
      childStepId++;
      innerSteps.push({
        type: 'ExecutableStepDTO',
        stepOrder: stepInGroup,
        childStepId,
        stepType: { stepTypeId: 4, stepTypeKey: 'recovery' },
        endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
        endConditionValue: bloc.recup * 60,
        targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
      });
    }

    return {
      type: 'RepeatGroupDTO',
      stepOrder: groupOrder,
      numberOfIterations: bloc.reps,
      smartRepeat: false,
      endCondition: { conditionTypeId: 7, conditionTypeKey: 'iterations' },
      workoutSteps: innerSteps,
    };
  });

  const workoutPayload = {
    workoutName,
    sportType: { sportTypeId: 1, sportTypeKey: 'running' },
    workoutSegments: [{
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: 'running' },
      workoutSteps,
    }],
  };

  try {
    const res = await fetch('https://connectapi.garmin.com/workout-service/workout', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GCM-iOS-5.7.2.1',
        'di-backend': 'connectapi.garmin.com',
      },
      body: JSON.stringify(workoutPayload),
    });

    if (res.status === 401) {
      return {
        statusCode: 401,
        headers: CORS,
        body: JSON.stringify({ error: 'Session expirée, reconnectez-vous' }),
      };
    }
    if (!res.ok) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'Erreur création séance' }),
      };
    }

    const data = await res.json();
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workoutId: data.workoutId, workoutName: data.workoutName }),
    };

  } catch {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Erreur création séance' }),
    };
  }
}
