import api from './client';

export const usersService = {
  updateDailyGoal: async (goal: number): Promise<{ daily_goal: number; message: string }> => {
    const response = await api.patch('/api/auth/goal/', { daily_goal: goal });
    return response.data;
  },
};
