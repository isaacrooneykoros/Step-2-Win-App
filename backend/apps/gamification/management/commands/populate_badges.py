from django.core.management.base import BaseCommand
from apps.gamification.models import Badge


class Command(BaseCommand):
    help = 'Populate initial badges for the gamification system'

    def handle(self, *args, **kwargs):
        badges_data = [
            {
                'slug': 'first-steps',
                'name': 'First Steps',
                'description': 'Joined your first challenge',
                'icon': '🚀',
                'badge_type': 'milestone',
                'color': '#4F9CF9',
                'criteria_type': 'first_challenge',
                'criteria_value': 1,
            },
            {
                'slug': 'first-victory',
                'name': 'First Victory',
                'description': 'Won your first challenge',
                'icon': '🏆',
                'badge_type': 'achievement',
                'color': '#FFD700',
                'criteria_type': 'first_win',
                'criteria_value': 1,
            },
            {
                'slug': 'step-master-50k',
                'name': 'Step Master',
                'description': 'Completed 50,000 steps in a single challenge',
                'icon': '👟',
                'badge_type': 'milestone',
                'color': '#22D3A0',
                'criteria_type': 'step_milestone',
                'criteria_value': 50000,
            },
            {
                'slug': 'step-legend-90k',
                'name': 'Step Legend',
                'description': 'Completed 90,000 steps in a single challenge',
                'icon': '⚡',
                'badge_type': 'milestone',
                'color': '#F5A623',
                'criteria_type': 'step_milestone',
                'criteria_value': 90000,
            },
            {
                'slug': 'winning-streak-3',
                'name': 'Hot Streak',
                'description': 'Won 3 challenges in a row',
                'icon': '🔥',
                'badge_type': 'streak',
                'color': '#FF6B6B',
                'criteria_type': 'challenge_wins',
                'criteria_value': 3,
            },
            {
                'slug': 'winning-streak-5',
                'name': 'Unstoppable',
                'description': 'Won 5 challenges in a row',
                'icon': '💪',
                'badge_type': 'streak',
                'color': '#845EF7',
                'criteria_type': 'challenge_wins',
                'criteria_value': 5,
            },
            {
                'slug': 'champion-10',
                'name': 'Champion',
                'description': 'Won 10 total challenges',
                'icon': '🥇',
                'badge_type': 'achievement',
                'color': '#FFD700',
                'criteria_type': 'challenge_wins',
                'criteria_value': 10,
            },
            {
                'slug': 'elite-25',
                'name': 'Elite',
                'description': 'Won 25 total challenges',
                'icon': '💎',
                'badge_type': 'achievement',
                'color': '#00D9FF',
                'criteria_type': 'challenge_wins',
                'criteria_value': 25,
            },
            {
                'slug': 'legend-50',
                'name': 'Legend',
                'description': 'Won 50 total challenges',
                'icon': '👑',
                'badge_type': 'achievement',
                'color': '#9B59B6',
                'criteria_type': 'challenge_wins',
                'criteria_value': 50,
            },
            {
                'slug': 'daily-dedication-7',
                'name': 'Weekly Warrior',
                'description': 'Active for 7 days in a row',
                'icon': '📅',
                'badge_type': 'streak',
                'color': '#3498DB',
                'criteria_type': 'streak_days',
                'criteria_value': 7,
            },
            {
                'slug': 'daily-dedication-30',
                'name': 'Monthly Master',
                'description': 'Active for 30 days in a row',
                'icon': '🗓️',
                'badge_type': 'streak',
                'color': '#E67E22',
                'criteria_type': 'streak_days',
                'criteria_value': 30,
            },
            {
                'slug': 'early-adopter',
                'name': 'Early Adopter',
                'description': 'Joined during the first month of Step2Win',
                'icon': '✨',
                'badge_type': 'achievement',
                'color': '#7C6FF7',
                'criteria_type': 'manual',
                'criteria_value': None,
            },
            {
                'slug': 'social-butterfly',
                'name': 'Social Butterfly',
                'description': 'Participated in 5 public challenges',
                'icon': '🦋',
                'badge_type': 'challenge',
                'color': '#FF69B4',
                'criteria_type': 'manual',
                'criteria_value': None,
            },
            {
                'slug': 'go-getter',
                'name': 'Go-Getter',
                'description': 'Completed daily step goal 10 times',
                'icon': '🎯',
                'badge_type': 'milestone',
                'color': '#16A085',
                'criteria_type': 'manual',
                'criteria_value': None,
            },
            {
                'slug': 'marathon-walker',
                'name': 'Marathon Walker',
                'description': 'Walked 1 million steps total',
                'icon': '🏃',
                'badge_type': 'milestone',
                'color': '#1ABC9C',
                'criteria_type': 'step_milestone',
                'criteria_value': 1000000,
            },
        ]

        created_count = 0
        updated_count = 0

        for badge_data in badges_data:
            badge, created = Badge.objects.update_or_create(
                slug=badge_data['slug'],
                defaults=badge_data
            )
            if created:
                created_count += 1
                self.stdout.write(self.style.SUCCESS(f'✓ Created badge: {badge.name}'))
            else:
                updated_count += 1
                self.stdout.write(self.style.WARNING(f'↻ Updated badge: {badge.name}'))

        self.stdout.write(self.style.SUCCESS(
            f'\nBadges populated successfully!\n'
            f'Created: {created_count}\n'
            f'Updated: {updated_count}\n'
            f'Total: {Badge.objects.count()}'
        ))
