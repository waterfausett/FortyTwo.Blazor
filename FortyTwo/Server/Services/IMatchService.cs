﻿using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using FortyTwo.Shared.Models;

namespace FortyTwo.Server.Services
{
    public interface IMatchService
    {
        Task<Match> CreateAsync();
        Task<List<Match>> FetchForUserAsync(bool completed);
        Task<Match> GetAsync(Guid id);
    }
}
