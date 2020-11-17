using System;
using System.Collections.Generic;

namespace FortyTwo.Shared.Models
{
    public class GameContext
    {
        public int Bid { get; set; }
        public int Trump { get; set; }
        public List<Trick> Tricks { get; set; } = new List<Trick>();
        public Trick CurrentTrick { get; set; }
        public Guid CurrentPlayerId { get; set; }
        public Team Us { get; set; }
        public Team Them { get; set; }
    }
}
