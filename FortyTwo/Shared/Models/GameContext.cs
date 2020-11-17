using System;

namespace FortyTwo.Shared.Models
{
    // TODO: think through this some more
    public class GameContext
    {
        public Guid Id { get; set; }
        public string Name { get; set; }
        public int Bid { get; set; }
        public int Trump { get; set; }
        public Trick CurrentTrick { get; set; }
        public Guid CurrentPlayerId { get; set; } // TODO: this could prolly be derived from the teams
        public Team Us { get; set; }
        public Team Them { get; set; }
    }
}
